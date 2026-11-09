const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const rooms = new Map();
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(data));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 16_384) {
        reject(Object.assign(new Error("Istek govdesi cok buyuk."), { status: 413 }));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(Object.assign(new Error("Gecersiz JSON."), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function normalizeText(value, maxLength = 100) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maxLength) : "";
}

function makeRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 5 }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function publicRoom(room) {
  return {
    code: room.code,
    phase: room.phase,
    players: room.players.map(({ id, name }) => ({ id, name })),
    hostPlayerId: room.hostPlayerId,
    team: room.team,
    country: room.country,
    winner: room.winner,
    lastResult: room.lastResult,
  };
}

async function wikidata(params) {
  const url = new URL("https://www.wikidata.org/w/api.php");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "FutbolcuBil/1.0 (football trivia game)" },
    });
    if (!response.ok) throw new Error(`Wikidata yaniti: HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function searchEntity(name, language = "tr") {
  const result = await wikidata({
    action: "wbsearchentities",
    search: name,
    language,
    uselang: language,
    type: "item",
    limit: "8",
    format: "json",
  });
  return result.search || [];
}

async function resolveRoundEntity(name, kind) {
  let matches = await searchEntity(name);
  if (!matches.length) matches = await searchEntity(name, "en");
  const desired = kind === "club"
    ? /football|soccer|futbol|spor kul[uü]b[uü]|club/i
    : /country|ulke|ülke|republic|kingdom|sovereign state/i;
  return matches.find((item) => desired.test(item.description || "")) || null;
}

async function getEntities(ids) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  const entities = {};
  for (let index = 0; index < uniqueIds.length; index += 50) {
    const result = await wikidata({
      action: "wbgetentities",
      ids: uniqueIds.slice(index, index + 50).join("|"),
      props: "claims|labels",
      languages: "tr|en",
      format: "json",
    });
    Object.assign(entities, result.entities || {});
  }
  return entities;
}

function claimIds(entity, property) {
  return (entity?.claims?.[property] || [])
    .map((claim) => claim.mainsnak?.datavalue?.value?.id)
    .filter(Boolean);
}

function isFootballer(entity) {
  return claimIds(entity, "P106").includes("Q937857");
}

function extractPhrases(text) {
  const words = text.match(/[\p{L}\p{M}\d'-]+/gu) || [];
  const phrases = [text];
  const capitalized = [];
  for (let index = 0; index < words.length; index += 1) {
    if (/^\p{Lu}/u.test(words[index])) {
      for (let length = 1; length <= 4 && index + length <= words.length; length += 1) {
        capitalized.push(words.slice(index, index + length).join(" "));
      }
    }
  }
  phrases.push(...capitalized.reverse(), ...words);
  return [...new Set(phrases.map((phrase) => phrase.trim()).filter((phrase) => phrase.length >= 2))].slice(0, 10);
}

async function findFootballer(text) {
  for (const phrase of extractPhrases(text)) {
    const results = await searchEntity(phrase);
    const footballers = results.filter((item) => item.id);
    if (!footballers.length) continue;
    const entities = await getEntities(footballers.slice(0, 5).map((item) => item.id));
    const match = footballers.find((item) => isFootballer(entities[item.id]));
    if (match) return { id: match.id, label: match.label, entity: entities[match.id] };
  }
  return null;
}

async function validateFootballer(text, room) {
  const player = await findFootballer(text);
  if (!player) return { valid: false, message: "Konusmada dogrulanabilir bir futbolcu adi bulunamadi." };

  const clubIds = claimIds(player.entity, "P54");
  const representedCountryIds = claimIds(player.entity, "P1532");
  const clubsAndTeams = await getEntities(clubIds);
  const playedForClub = clubIds.includes(room.team.id);
  const playedForNationalSide = representedCountryIds.includes(room.country.id)
    || clubIds.some((id) => claimIds(clubsAndTeams[id], "P17").includes(room.country.id));

  if (playedForClub && playedForNationalSide) {
    return { valid: true, player: player.label };
  }

  const missing = [];
  if (!playedForClub) missing.push(`${room.team.label} formasiyla oynama`);
  if (!playedForNationalSide) missing.push(`${room.country.label} milli takiminda oynama`);
  return {
    valid: false,
    player: player.label,
    message: `${player.label} bulundu; ancak Wikidata'da ${missing.join(" ve ")} bilgisi dogrulanamadi.`,
  };
}

async function handleApi(request, response, url) {
  const parts = url.pathname.split("/").filter(Boolean);
  const method = request.method;

  if (method === "POST" && url.pathname === "/api/rooms") {
    const body = await readBody(request);
    const name = normalizeText(body.name, 24);
    if (!name) return sendJson(response, 400, { error: "Oyuncu adini gir." });
    const code = makeRoomCode();
    const playerId = crypto.randomUUID();
    const room = {
      code,
      phase: "lobby",
      players: [{ id: playerId, name }],
      hostPlayerId: playerId,
      team: null,
      country: null,
      winner: null,
      lastResult: null,
      guessQueue: Promise.resolve(),
      touchedAt: Date.now(),
    };
    rooms.set(code, room);
    return sendJson(response, 201, { playerId, room: publicRoom(room) });
  }

  if (parts[0] !== "api" || parts[1] !== "rooms" || !parts[2]) {
    return sendJson(response, 404, { error: "API adresi bulunamadi." });
  }
  const code = parts[2].toUpperCase();
  const room = rooms.get(code);
  if (!room) return sendJson(response, 404, { error: "Oda bulunamadi veya suresi doldu." });
  room.touchedAt = Date.now();

  if (method === "GET" && parts.length === 3) {
    return sendJson(response, 200, { room: publicRoom(room) });
  }

  if (method === "POST" && parts[3] === "join") {
    const body = await readBody(request);
    const name = normalizeText(body.name, 24);
    if (!name) return sendJson(response, 400, { error: "Oyuncu adini gir." });
    if (room.phase !== "lobby") return sendJson(response, 409, { error: "Oyun basladigi icin bu odaya katilamazsin." });
    if (room.players.length >= 2) return sendJson(response, 409, { error: "Oda dolu." });
    const playerId = crypto.randomUUID();
    room.players.push({ id: playerId, name });
    return sendJson(response, 201, { playerId, room: publicRoom(room) });
  }

  if (method === "POST" && parts[3] === "start") {
    const body = await readBody(request);
    if (body.playerId !== room.hostPlayerId) return sendJson(response, 403, { error: "Oyunu yalnizca odayi kuran oyuncu baslatabilir." });
    if (room.players.length !== 2) return sendJson(response, 409, { error: "Oyunu baslatmak icin iki oyuncu da odaya katilmali." });
    if (room.phase !== "lobby") return sendJson(response, 409, { error: "Oyun zaten baslamis." });
    const teamName = normalizeText(body.team, 80);
    const countryName = normalizeText(body.country, 80);
    if (!teamName || !countryName) return sendJson(response, 400, { error: "Takim ve ulke adini gir." });
    try {
      const [team, country] = await Promise.all([
        resolveRoundEntity(teamName, "club"),
        resolveRoundEntity(countryName, "country"),
      ]);
      if (!team || !country) return sendJson(response, 422, { error: "Takim veya ulke Wikidata'da bulunamadi; adlari kontrol et." });
      room.team = { id: team.id, label: team.label };
      room.country = { id: country.id, label: country.label };
      room.phase = "active";
      return sendJson(response, 200, { room: publicRoom(room) });
    } catch (error) {
      return sendJson(response, 502, { error: `Wikidata'ya ulasilamadi: ${error.message}` });
    }
  }

  if (method === "POST" && parts[3] === "guess") {
    const body = await readBody(request);
    const player = room.players.find((item) => item.id === body.playerId);
    const utterance = normalizeText(body.text, 180);
    if (!player) return sendJson(response, 403, { error: "Bu oyuncu odaya kayitli degil." });
    if (!utterance) return sendJson(response, 400, { error: "Duyulan futbolcu adini gir." });
    if (room.phase !== "active") return sendJson(response, 409, { error: "Su anda aktif bir oyun yok." });

    const result = room.guessQueue.then(async () => {
      if (room.phase !== "active") return { status: 409, body: { error: "Bu tur zaten sona erdi.", room: publicRoom(room) } };
      const verification = await validateFootballer(utterance, room);
      if (verification.valid) {
        room.phase = "finished";
        room.winner = { playerId: player.id, name: player.name, footballer: verification.player };
        room.lastResult = { playerId: player.id, message: `${verification.player} dogru! ${player.name} kazandi.`, valid: true };
        return { status: 200, body: { room: publicRoom(room) } };
      }
      room.lastResult = { playerId: player.id, message: verification.message, valid: false };
      return { status: 200, body: { room: publicRoom(room) } };
    });
    room.guessQueue = result.then(() => undefined, () => undefined);
    try {
      const outcome = await result;
      return sendJson(response, outcome.status || 200, outcome.body || outcome);
    } catch (error) {
      return sendJson(response, 502, { error: `Futbolcu kontrolu basarisiz: ${error.message}` });
    }
  }

  return sendJson(response, 404, { error: "API adresi bulunamadi." });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    try {
      await handleApi(request, response, url);
    } catch (error) {
      if (!response.headersSent) sendJson(response, error.status || 500, { error: error.message || "Sunucu hatasi." });
    }
    return;
  }

  const requestedPath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const filePath = path.resolve(PUBLIC_DIR, requestedPath);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    response.writeHead(403);
    return response.end("Forbidden");
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return response.end("Dosya bulunamadi.");
    }
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    response.end(content);
  });
});

setInterval(() => {
  const expiration = Date.now() - 2 * 60 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (room.touchedAt < expiration) rooms.delete(code);
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`Futbolcu Bil hazir: http://localhost:${PORT}`);
});
