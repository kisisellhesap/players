const $ = (selector) => document.querySelector(selector);
const homeScreen = $("#home-screen");
const roomScreen = $("#room-screen");
const entryError = $("#entry-error");
const roomError = $("#room-error");
const recognitionAvailable = "SpeechRecognition" in window || "webkitSpeechRecognition" in window;

let playerId = sessionStorage.getItem("playerId");
let roomCode = sessionStorage.getItem("roomCode");
let roomState = null;
let pollTimer = null;
let recognition = null;
let recognitionWanted = false;
let requestPending = false;
let pointerHeld = false;
let lastListenMode = $("#listen-mode").value;

function setError(element, message = "") {
  element.textContent = message;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Istek basarisiz (${response.status}).`);
  return result;
}

function setBusy(button, busy, text) {
  button.disabled = busy;
  if (text) button.textContent = busy ? text : button.dataset.originalText;
}

function rememberRoom(code, id) {
  roomCode = code;
  playerId = id;
  sessionStorage.setItem("roomCode", code);
  sessionStorage.setItem("playerId", id);
}

function clearRoom() {
  stopRecognition();
  clearInterval(pollTimer);
  sessionStorage.removeItem("roomCode");
  sessionStorage.removeItem("playerId");
  roomCode = null;
  playerId = null;
  roomState = null;
  roomScreen.classList.add("hidden");
  homeScreen.classList.remove("hidden");
}

function showRoom(room) {
  roomState = room;
  homeScreen.classList.add("hidden");
  roomScreen.classList.remove("hidden");
  $("#copy-code").textContent = room.code;

  const ownPlayer = room.players.find((player) => player.id === playerId);
  const host = playerId === room.hostPlayerId;
  $("#player-one").textContent = room.players[0]?.name || "-";
  $("#player-two").textContent = room.players[1]?.name || "Bekleniyor...";
  $("#opponent-state").textContent = room.players[1] ? "Oyuna hazir" : "Oda koduyla katilsin";
  $("#waiting-message").classList.toggle("hidden", room.players.length === 2);
  $("#setup-form").classList.toggle("hidden", room.phase !== "lobby" || !host || room.players.length !== 2);
  $("#lobby-panel").classList.toggle("hidden", room.phase !== "lobby");
  $("#active-panel").classList.toggle("hidden", room.phase !== "active");
  $("#finished-panel").classList.toggle("hidden", room.phase !== "finished");
  $("#phase-eyebrow").textContent = room.phase === "lobby" ? "ODA BEKLIYOR" : room.phase === "active" ? "CANLI TUR" : "TUR TAMAMLANDI";
  $("#room-title").textContent = room.phase === "lobby" ? (room.players.length === 2 ? "Turunu kur" : "Takimini bekle") : room.phase === "active" ? "Hedef futbolcuyu bul" : "Mac sona erdi";

  if (room.phase === "active") {
    $("#target-team").textContent = room.team.label;
    $("#target-country").textContent = room.country.label;
    $("#race-player-one").textContent = room.players[0] ? `${room.players[0].name}${room.players[0].id === playerId ? " (sen)" : ""}` : "";
    $("#race-player-two").textContent = room.players[1] ? `${room.players[1].name}${room.players[1].id === playerId ? " (sen)" : ""}` : "";
    $("#race-player-one").classList.toggle("current-player", room.players[0]?.id === playerId);
    $("#race-player-two").classList.toggle("current-player", room.players[1]?.id === playerId);
    if (room.lastResult) {
      $("#game-result").textContent = room.lastResult.message;
      $("#game-result").classList.toggle("invalid", !room.lastResult.valid);
    }
    syncListenMode();
  }

  if (room.phase === "finished" && room.winner) {
    stopRecognition();
    $("#winner-title").textContent = `${room.winner.name} kazandi!`;
    $("#winner-detail").textContent = `Dogru cevap: ${room.winner.footballer}`;
  } else if (ownPlayer && !room.players.some((player) => player.id === playerId)) {
    clearRoom();
  }
}

async function refreshRoom() {
  if (!roomCode) return;
  try {
    const result = await api(`/api/rooms/${encodeURIComponent(roomCode)}`);
    if (!result.room.players.some((player) => player.id === playerId)) {
      clearRoom();
      setError(entryError, "Oda bilgisi bulunamadi. Yeni bir oda kur veya tekrar katil.");
      return;
    }
    showRoom(result.room);
    setError(roomError);
  } catch (error) {
    setError(roomError, error.message);
  }
}

function beginPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(refreshRoom, 1000);
  refreshRoom();
}

$("#create-room").dataset.originalText = "Oda olustur →";
$("#join-room").dataset.originalText = "Katil";
$("#start-game").dataset.originalText = "Turu baslat →";
$("#submit-guess").dataset.originalText = "Kontrol et";

$("#create-room").addEventListener("click", async () => {
  setError(entryError);
  const button = $("#create-room");
  setBusy(button, true, "Oda aciliyor...");
  try {
    const result = await api("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ name: $("#player-name").value }),
    });
    rememberRoom(result.room.code, result.playerId);
    showRoom(result.room);
    beginPolling();
  } catch (error) {
    setError(entryError, error.message);
  } finally {
    setBusy(button, false);
  }
});

$("#join-room").addEventListener("click", async () => {
  setError(entryError);
  const button = $("#join-room");
  setBusy(button, true, "Katiliniyor...");
  try {
    const code = $("#room-code").value.trim().toUpperCase();
    const result = await api(`/api/rooms/${encodeURIComponent(code)}/join`, {
      method: "POST",
      body: JSON.stringify({ name: $("#player-name").value }),
    });
    rememberRoom(code, result.playerId);
    showRoom(result.room);
    beginPolling();
  } catch (error) {
    setError(entryError, error.message);
  } finally {
    setBusy(button, false);
  }
});

$("#room-code").addEventListener("input", (event) => {
  event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
});

$("#start-game").addEventListener("click", async () => {
  setError(roomError);
  const button = $("#start-game");
  setBusy(button, true, "Hedefler aranıyor...");
  try {
    const result = await api(`/api/rooms/${encodeURIComponent(roomCode)}/start`, {
      method: "POST",
      body: JSON.stringify({
        playerId,
        team: $("#team-name").value,
        country: $("#country-name").value,
      }),
    });
    showRoom(result.room);
  } catch (error) {
    setError(roomError, error.message);
  } finally {
    setBusy(button, false);
  }
});

async function submitGuess(text) {
  if (requestPending || !roomCode || roomState?.phase !== "active") return;
  const guess = (text || $("#guess-input").value).trim();
  if (!guess) {
    setError(roomError, "Once duyulan futbolcu adini veya cumleyi gir.");
    return;
  }
  requestPending = true;
  $("#submit-guess").disabled = true;
  setError(roomError);
  $("#game-result").textContent = "Futbolcu ve istatistikler kontrol ediliyor...";
  $("#game-result").classList.remove("invalid");
  try {
    const result = await api(`/api/rooms/${encodeURIComponent(roomCode)}/guess`, {
      method: "POST",
      body: JSON.stringify({ playerId, text: guess }),
    });
    showRoom(result.room);
    if (result.room.lastResult?.playerId === playerId && !result.room.lastResult.valid) {
      $("#guess-input").value = "";
    }
  } catch (error) {
    setError(roomError, error.message);
  } finally {
    requestPending = false;
    $("#submit-guess").disabled = false;
  }
}

$("#submit-guess").addEventListener("click", () => submitGuess());
$("#guess-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") submitGuess();
});

function createRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    $("#voice-status").textContent = "Tarayicin konusma tanimayi desteklemiyor";
    return null;
  }
  const instance = new Recognition();
  instance.lang = "tr-TR";
  instance.continuous = true;
  instance.interimResults = true;
  instance.onstart = () => {
    $("#voice-status").textContent = "Dinliyor...";
    $("#talk-button").classList.add("listening");
  };
  instance.onresult = (event) => {
    let finalText = "";
    let interimText = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const text = event.results[index][0].transcript.trim();
      if (event.results[index].isFinal) finalText += `${text} `;
      else interimText += `${text} `;
    }
    if (interimText) $("#guess-input").value = interimText.trim();
    if (finalText.trim()) {
      $("#guess-input").value = finalText.trim();
      submitGuess(finalText.trim());
    }
  };
  instance.onerror = (event) => {
    if (event.error !== "no-speech" && event.error !== "aborted") {
      $("#voice-status").textContent = `Mikrofon hatasi: ${event.error}`;
    }
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      recognitionWanted = false;
    }
  };
  instance.onend = () => {
    $("#talk-button").classList.remove("listening");
    const mode = $("#listen-mode").value;
    if (recognitionWanted && (mode === "session_listen" || mode === "ambient")) {
      window.setTimeout(startRecognition, 350);
    } else if (mode === "push_to_talk" && pointerHeld) {
      startRecognition();
    } else {
      $("#voice-status").textContent = "Mikrofon kapali";
    }
  };
  return instance;
}

function startRecognition() {
  if (!recognitionAvailable) {
    $("#voice-status").textContent = "Konusma tanima bu tarayicida desteklenmiyor";
    return;
  }
  if (!recognition) recognition = createRecognition();
  if (!recognition) return;
  try {
    recognition.start();
  } catch (error) {
    if (error.name !== "InvalidStateError") $("#voice-status").textContent = `Mikrofon baslatilamadi: ${error.message}`;
  }
}

function stopRecognition() {
  recognitionWanted = false;
  pointerHeld = false;
  if (recognition) recognition.stop();
  $("#talk-button").classList.remove("listening");
  $("#voice-status").textContent = "Mikrofon kapali";
}

function syncListenMode() {
  const mode = $("#listen-mode").value;
  $("#talk-button").classList.toggle("hidden", mode !== "push_to_talk");
  $("#ambient-button").classList.toggle("hidden", mode !== "ambient");
  if (mode !== lastListenMode) {
    if (recognitionWanted) stopRecognition();
    lastListenMode = mode;
  }
  if (mode === "session_listen" && roomState?.phase === "active" && !recognitionWanted) {
    recognitionWanted = true;
    startRecognition();
  }
}

$("#listen-mode").addEventListener("change", syncListenMode);
$("#talk-button").addEventListener("pointerdown", (event) => {
  event.preventDefault();
  pointerHeld = true;
  startRecognition();
});
for (const eventName of ["pointerup", "pointerleave", "pointercancel"]) {
  $("#talk-button").addEventListener(eventName, () => {
    if ($("#listen-mode").value !== "push_to_talk") return;
    pointerHeld = false;
    if (recognition) recognition.stop();
  });
}
$("#ambient-button").addEventListener("click", () => {
  if (recognitionWanted) {
    stopRecognition();
    $("#ambient-button").textContent = "Dinlemeyi baslat";
  } else {
    recognitionWanted = true;
    $("#ambient-button").textContent = "Dinlemeyi durdur";
    startRecognition();
  }
});
$("#copy-code").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(roomCode);
    $("#copy-code").textContent = "KOPYALANDI";
    window.setTimeout(() => { if (roomCode) $("#copy-code").textContent = roomCode; }, 1200);
  } catch {
    setError(roomError, "Oda kodu kopyalanamadi; elle paylasabilirsin.");
  }
});
$("#leave-room").addEventListener("click", clearRoom);

if (roomCode && playerId) {
  homeScreen.classList.add("hidden");
  roomScreen.classList.remove("hidden");
  beginPolling();
}

if (!recognitionAvailable) {
  $("#voice-status").textContent = "Konusma tanima icin Chrome veya Edge kullan";
}
