// config.js
// ⚠️ Jangan upload file ini ke repo publik karena ada BOT_TOKEN

module.exports = {
  // Bisa isi langsung di sini, atau pakai ENV BOT_TOKEN di Pterodactyl.
  BOT_TOKEN: process.env.BOT_TOKEN || '',

  // Ganti dengan @username channel kamu
  CHANNELS: [
  '@info_pemersatubngsa',
  '@pemersatubangsareall',
  '@farinmods'
],

  WITHDRAW_CHANNEL: '@pemersatubangsareall',   // 👈 channel log penarikan

  // Isi dengan Telegram ID admin (ANGKA, bukan @username)
  // Bisa lebih dari satu admin
  ADMIN_IDS: [
    7355538049, // ganti dengan ID kamu
    // 987654321, // admin lain kalau ada
  ],
};