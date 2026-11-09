# Futbolcu Bil

Iki oyuncunun farkli cihazlardan oda koduyla katildigi, ayni kulupte oynamis ve ayni ulkenin milli takiminda yer almis futbolcuyu ilk bulma oyunu.

## Calistirma

Node.js 20 veya ustu gerekir.

```powershell
npm start
```

Tarayicida `http://localhost:3000` adresini acin. Uzak cihazlardan oynamak icin uygulamanin HTTPS destekleyen bir sunucuda yayinlanmasi gerekir; odalar su an uygulama sunucusunun bellekteki gecici verileridir.

## Konusma tanima

Konusma tanima icin Chrome veya Edge ve mikrofon izni gerekir. Bas-konus varsayilan moddur; oyun boyunca dinleme ve kullanicinin elle baslattigi surekli dinleme de secilebilir. Tarayici konusma tanima hizmeti sesi nasil isliyorsa bu davranis tarayiciya baglidir. Algilanan metin oyun sunucusuna, futbolcu aramasi icin de Wikidata'ya gonderilir.

## Dogrulama

Takim, ulke ve futbolcu bilgileri Wikidata arama API'si uzerinden kontrol edilir. Dogrulama, Wikidata'da yer alan takim gecmisi (`P54`), sporcunun temsil ettigi ulke (`P1532`) veya milli takim kaydinin ulkesi (`P17`) ile sinirlidir; kayit eksikse dogru bir cevap da otomatik olarak dogrulanamayabilir.

## MVP sinirlari

- Odalar uygulama sunucusu yeniden baslayana veya oda iki saat etkin olmayana kadar bellekte kalir.
- Oyuncu kimligi bu MVP'de oturum depolamasinda tutulur; hesap sistemi ve kalici skor yoktur.
- Her iki oyuncu da ayni oda icinde ayni takim ve ulke hedefiyle yarisir.
