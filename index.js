// index.js
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const { BOT_TOKEN, CHANNELS, ADMIN_IDS } = require('./config');
// =====================
// CEK KONFIG
// =====================
if (!BOT_TOKEN || BOT_TOKEN === 'ISI_TOKEN_BOT_DISINI') {
  console.error('ERROR: BOT_TOKEN belum diisi di config.js atau ENV!');
  process.exit(1);
}


const userCommands = [
  { command: 'start', description: 'Mulai bot' },
  { command: 'ref', description: 'Link referral untuk undang teman' },
  { command: 'saldo', description: 'Lihat saldo & info referral' },
  { command: 'tarik', description: 'Ajukan penarikan saldo' },
  { command: 'riwayat', description: 'Lihat Riwayat Penarikan' },
];

const adminCommands = [
  // perintah user (biar admin juga punya)
  { command: 'start', description: 'Mulai bot' },
  { command: 'ref', description: 'Link referral untuk undang teman' },
  { command: 'saldo', description: 'Lihat saldo & info referral' },
  { command: 'tarik', description: 'Ajukan penarikan saldo' },
   { command: 'riwayat', description: 'Lihat Riwayat Penarikan' },

  // perintah khusus admin
  { command: 'stats', description: 'Statistik User' },
  { command: 'peringatan', description: 'Peringatkan user yang tidak follow' },
  { command: 'broadcast', description: 'Kirim pesan ke semua user' },
  { command: 'kirimvideo', description: 'Upload video ke menu bot' },
  { command: 'hapusvideo', description: 'Hapus video dari menu' },
  { command: 'editvideo', description: 'Edit judul video' },
  { command: 'addsaldo', description: 'Tambah saldo user (admin)' },
];

const bot = new Telegraf(BOT_TOKEN);

let statsRunning = false;
let statsStopRequested = false;

let statsResult = {
  follow: [],
  unfollow: [],
  checked: 0,
  total: 0
};

// =====================
// DATA IN-MEMORY
// =====================

// userId -> { verified: bool, blocked: bool }
const users = new Map();

// daftar video (admin push lewat /kirimvideo reply)
// struktur: { id, title, fileId, caption, command, deleted }
let videos = [];

// idWithdraw -> data penarikan
const pendingWithdraws = new Map();

// =====================
// AUTO WARNING SYSTEM
// =====================
const warningQueue = [];
let warningRunning = false;

let lastWarningReport = {
  sent: 0,
  failed: 0,
  checked: 0
};

// ======== LOAD BACKUP DATA JIKA ADA ========
try {
  const backupFolder = path.join(__dirname, 'backup');
  const videosFile = path.join(backupFolder, 'videos.json');
  const usersFile = path.join(backupFolder, 'users.json');

  if (fs.existsSync(videosFile)) {
    const fileData = JSON.parse(fs.readFileSync(videosFile));
    if (Array.isArray(fileData)) {
      videos = fileData;
      console.log(`🟢 Restore videos berhasil (${videos.length} items)`);
    }
  }

  if (fs.existsSync(usersFile)) {
    const userData = new Map(JSON.parse(fs.readFileSync(usersFile)));
    if (userData) {
      users.clear();
      for (const [id, info] of userData) users.set(Number(id), info);
      console.log(`🟢 Restore users berhasil (${users.size} users)`);
    }
  }
} catch (err) {
  console.error("❌ Restore backup gagal:", err.message);
}

function saveBackup() {
  try {
    const folder = path.join(__dirname, 'backup');
    if (!fs.existsSync(folder)) fs.mkdirSync(folder);

    fs.writeFileSync(
      path.join(folder, 'videos.json'),
      JSON.stringify(videos, null, 2)
    );

    fs.writeFileSync(
      path.join(folder, 'users.json'),
      JSON.stringify([...users.entries()], null, 2)
    );

    return true;
  } catch (err) {
    console.error('Backup error:', err);
    return false;
  }
}

async function backupAndSend(ctx, reason = '') {
  try {
    const ok = saveBackup();
    if (!ok) {
      console.error('Backup gagal disimpan ke file.');
      return;
    }

    const adminSendTo = ADMIN_IDS[0];
    const folder = path.join(__dirname, 'backup');

    // kirim users.json
    await ctx.telegram.sendDocument(adminSendTo, {
      source: path.join(folder, 'users.json'),
      filename: 'users.json',
    });

    // kirim videos.json (kalau kamu pakai)
    await ctx.telegram.sendDocument(adminSendTo, {
      source: path.join(folder, 'videos.json'),
      filename: 'videos.json',
    });

    if (reason) {
      await ctx.telegram.sendMessage(
        adminSendTo,
        `📦 Backup terkirim.\nAlasan: ${reason}`
      );
    }
  } catch (err) {
    console.error('❌ Gagal kirim backup ke admin:', err.message);
  }
}

// bikin nama perintah dari judul video, misalnya:
// "Pelajaran Matematika!" -> "pelajaranmatematika"
function makeCommandFromTitle(title, fallbackId) {
  // ubah ke huruf kecil
  let cmd = title.toLowerCase();

  // hapus semua karakter selain huruf & angka
  cmd = cmd.replace(/[^a-z0-9]+/g, '');

  // kalau hasilnya kosong (judul aneh semua), pakai fallback
  if (!cmd) {
    cmd = 'video' + fallbackId;
  }

  return cmd;
}

const PAGE_SIZE = 6;

// Fungsi untuk format angka rupiah
function formatRupiah(angka) {
  return angka.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// buat amanin teks biar nggak ngerusak HTML
function escapeHtml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const MIN_WITHDRAW = 50400;
const WITHDRAW_CHANNEL = '@WidrawAwalFarin';
const REF_BONUS = 1050;
// =====================
// FUNGSI BANTU
// =====================

function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

function ensureUser(ctx) {
  if (!ctx.from) return null;
  const id = ctx.from.id;

  let isNew = false;

  if (!users.has(id)) {
    isNew = true;
    users.set(id, {
      verified: false,
      blocked: false,
      joined_at: Date.now(),
      balance: 0,          // kalau kamu sudah punya boleh abaikan
      referrerId: null,    // kalau sudah ada juga gapapa
      refs: 0,             // "
      withdraws: [],       // ✅ tempat nyimpan riwayat tarik
    });
  }

  const user = users.get(id);

  // kalau user lama tapi belum ada withdraws, inisialisasi
  if (!Array.isArray(user.withdraws)) {
    user.withdraws = [];
  }

  // 🔥 auto-backup user baru (punya kamu tadi) biarkan aja di bawah ini
  if (isNew) {
    (async () => {
      try {
        const backupOk = saveBackup();
        if (backupOk) {
          const adminSendTo = ADMIN_IDS[0];

          await ctx.telegram.sendDocument(adminSendTo, {
            source: path.join(__dirname, 'backup', 'videos.json'),
            filename: 'videos.json',
          });

          await ctx.telegram.sendDocument(adminSendTo, {
            source: path.join(__dirname, 'backup', 'users.json'),
            filename: 'users.json',
          });

          console.log('Auto-backup user baru terkirim ke admin');
        } else {
          console.error('Auto-backup user baru gagal: saveBackup() mengembalikan false');
        }
      } catch (err) {
        console.error('Auto-backup user baru error:', err.message);
      }
    })();
  }

  return user;
}

// =====================
// WARNING WORKER (BACKGROUND)
// =====================
async function runWarningWorker(ctx) {
  if (warningRunning) return;
  warningRunning = true;

  while (warningQueue.length > 0) {
    const userId = warningQueue.shift();
    lastWarningReport.checked++;

    try {
      const stillSub = await isSubscribed(ctx, userId);

      if (!stillSub) {
        const keyboard = {
          inline_keyboard: [
            [
              {
                text: '📢 Channel 1',
                url: `https://t.me/${CHANNELS[0].replace('@', '')}`
              }
            ],
            [
              {
                text: '📢 Channel 2',
                url: `https://t.me/${CHANNELS[1].replace('@', '')}`
              }
            ],
            [
              {
                text: '📢 Channel 3',
                url: `https://t.me/${CHANNELS[2].replace('@', '')}`
              }
            ],
            [
              {
                text: '✅ Sudah Follow Semua',
                callback_data: 'verify_follow'
              }
            ]
          ]
        };

        await ctx.telegram.sendMessage(
          userId,
          '<blockquote>⚠️ <b>Peringatan Otomatis</b></blockquote>\n' +
          'Kamu terdeteksi belum mengikuti semua channel wajib.\n\n' +
          '<b>Silakan follow semua channel di bawah ini agar akses bot tetap aktif.</b>',
          {
            parse_mode: 'HTML',
            reply_markup: keyboard
          }
        );

        lastWarningReport.sent++;
        await new Promise(r => setTimeout(r, 150)); // anti flood
      }
    } catch (err) {
      lastWarningReport.failed++;
    }
  }

  warningRunning = false;
}

// =====================
// KIRIM LAPORAN KE ADMIN
// =====================
async function sendWarningReportToAdmin() {
  const text =
    '📊 <b>Laporan Auto Peringatan</b>\n\n' +
    `👥 Dicek: ${lastWarningReport.checked}\n` +
    `⚠️ Terkirim: ${lastWarningReport.sent}\n` +
    `❌ Gagal: ${lastWarningReport.failed}\n\n` +
    `⏰ ${new Date().toLocaleString('id-ID')}`;

  for (const adminId of ADMIN_IDS) {
    try {
      await bot.telegram.sendMessage(adminId, text, { parse_mode: 'HTML' });
    } catch {}
  }
}

// =====================
// REFERRAL & SALDO (HELPER)
// =====================

// bikin link referral: https://t.me/NAMABOT?start=ref_userid
function getReferralLink(ctx, userId) {
  // coba ambil username bot dari context
  const botUsername = ctx.botInfo?.username || process.env.BOT_USERNAME || 'NAMA_BOT_KAMU';
  return `https://t.me/${botUsername}?start=ref_${userId}`;
}

// kirim menu saldo, dan hapus pesan saldo lama biar chat rapi
async function sendWalletMenu(ctx, user) {
  // hapus pesan saldo sebelumnya kalau masih ada
  if (user.last_wallet_msg_id) {
    try {
      await ctx.deleteMessage(user.last_wallet_msg_id);
    } catch (err) {
      // kalau sudah kadaluarsa / bukan pesan bot, abaikan saja
      // console.error('Gagal hapus pesan saldo lama:', err.message);
    }
  }

  const saldo = user.balance || 0;
  const totalRef = user.total_ref || 0;

  const saldoText = formatRupiah(saldo);
  const minText = formatRupiah(MIN_WITHDRAW);
  const link = getReferralLink(ctx, ctx.from.id);

const teks =
  '<blockquote>💰 <b>Saldo & Referral Kamu</b></blockquote>\n' +
  `• Saldo: <b>Rp ${saldoText}</b>\n` +
  `• Teman berhasil diajak: <b>${totalRef}</b>\n` +
  `• Minimal penarikan: <b>Rp ${minText}</b>\n\n` +
  '🔗 <b>Link referral kamu:</b>\n' +
  `<code>${link}</code>\n` +
  '<blockquote><b>Untuk tarik saldo:</b> <code>/tarik [nominal] [payment] [no]</code></blockquote>\n';

const msg = await ctx.reply(teks, { parse_mode: 'HTML' });

  // simpan id pesan saldo terakhir supaya bisa dihapus di pemanggilan berikutnya
  user.last_wallet_msg_id = msg.message_id;
  saveBackup();
}

async function isSubscribed(ctx, userId) {
  try {
    for (const ch of CHANNELS) {
      const member = await ctx.telegram.getChatMember(ch, userId);
      const ok = ['member', 'administrator', 'creator'].includes(member.status);
      if (!ok) return false; // kalau salah satu channel belum di-follow → dianggap belum subscribe
    }
    return true; // semua channel di CHANNELS sudah di-follow
  } catch (err) {
    console.error('getChatMember error:', err.message);
    return false;
  }
}

async function sendVerifyMessage(ctx) {
  const caption =
    'Untuk melanjutkan penggunaan bot ini, harap mengikuti ketiga channel berikut terlebih dahulu:\n\n';

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.url(
        '📢 Channel 1',
        `https://t.me/${CHANNELS[0].replace('@', '')}`
      )
    ],
    [
      Markup.button.url(
        '📢 Channel 2',
        `https://t.me/${CHANNELS[1].replace('@', '')}`
      )
    ],
        [
      Markup.button.url(
        '📢 Channel 3',
        `https://t.me/${CHANNELS[2].replace('@', '')}`
      )
    ],
    [Markup.button.callback('✅ Sudah Follow Semua', 'verify_follow')],
  ]);

  const imagePath = path.join(__dirname, 'verify.jpg'); // pakai gambar lokal

  try {
    if (fs.existsSync(imagePath)) {
      return await ctx.replyWithPhoto(
        { source: imagePath },
        {
          caption,
          parse_mode: 'Markdown',
          ...keyboard,
        }
      );
    } else {
      console.warn('⚠️ File verify.jpg tidak ditemukan — fallback ke teks');
      return ctx.reply(caption, { parse_mode: 'Markdown', ...keyboard });
    }
  } catch (err) {
    console.error('❌ Error kirim gambar verifikasi:', err.message);
    return ctx.reply(caption, { parse_mode: 'Markdown', ...keyboard });
  }
}


async function sendMainMenu(ctx, page = 1, edit = false) {
  // hanya video yang belum dihapus
  const activeVideos = videos.filter((v) => !v.deleted);
  const totalItems = activeVideos.length;

  // gambar header menu (upload file ini di folder yang sama dengan index.js)
  const MENU_IMAGE = path.join(__dirname, 'verify.jpg'); // boleh ganti nama filenya

  // ==============
  // KASUS: BELUM ADA VIDEO
  // ==============
  if (totalItems === 0) {
    const text =
      `<b>❌ Belum ada video yang diunggah admin.</b>\n\n` +
      `Silakan tunggu video edukasi terbaru 😊`;

    const kb = Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh', 'refresh_menu')],
    ]);

    if (edit && ctx.updateType === 'callback_query') {
      try {
        await ctx.editMessageText(text, {
          parse_mode: 'HTML',
          reply_markup: kb.reply_markup,
        });
      } catch (e) {
        console.error('edit no-video menu error:', e.message);
        try {
          await ctx.answerCbQuery().catch(() => {});
        } catch {}
      }
      return;
    }

    // kirim foto kalau ada
    if (fs.existsSync(MENU_IMAGE)) {
      try {
        return await ctx.replyWithPhoto(
          { source: MENU_IMAGE },
          {
            caption: text,
            parse_mode: 'HTML',
            reply_markup: kb.reply_markup,
          }
        );
      } catch (e) {
        console.error('send no-video photo error:', e.message);
      }
    }

    // fallback tanpa foto
    return ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: kb.reply_markup,
    });
  }

  // ==============
  // KASUS: SUDAH ADA VIDEO
  // ==============
  const totalPages = Math.ceil(totalItems / PAGE_SIZE);
  if (page < 1) page = 1;
  if (page > totalPages) page = totalPages;

  const startIdx = (page - 1) * PAGE_SIZE;
  const endIdx = Math.min(startIdx + PAGE_SIZE, totalItems);
  const pageItems = activeVideos.slice(startIdx, endIdx);

  // ambil username / nama buat sapaan
  let username = 'kamu';
  if (ctx.from) {
    if (ctx.from.username) {
      username = '@' + ctx.from.username;
    } else if (ctx.from.first_name) {
      username = ctx.from.first_name;
    }
  }

let text = `👋 Halo <b>${username}</b> Selamat datang di bot Pemersatu Bangsa V2`;
  text += '<blockquote>Saya di sini bertugas untuk memberi kalian semua bahan Video yang gacor dan free ya pastinya.</blockquote>\n\n';
  text += '<b>Silakan pilih video yang ada di sini:</b>\n';
  text += '───────────────────────\n';

  pageItems.forEach((vid, index) => {
    const nomor = startIdx + index + 1;
    text += `${nomor}. /${vid.command}\n`;
  });

  text += `<blockquote>Halaman ${page}/${totalPages}</blockquote>`;

  const buttons = [];
  const navRow = [];
  if (page > 1)
    navRow.push(Markup.button.callback('⬅️ Kembali', `page_${page - 1}`));
  if (page < totalPages)
    navRow.push(Markup.button.callback('Lanjut ➡️', `page_${page + 1}`));
  if (navRow.length) buttons.push(navRow);

  buttons.push([Markup.button.callback('🔄 Refresh', `page_${page}`)]);

  const kb = Markup.inlineKeyboard(buttons);

  // kalau dipanggil dari tombol (callback_query) → edit pesan lama
  if (edit && ctx.updateType === 'callback_query') {
    try {
      const msg = ctx.callbackQuery?.message;

      if (msg && msg.photo) {
        // kalau menu sebelumnya dikirim sebagai foto + caption
        await ctx.editMessageCaption(text, {
          parse_mode: 'HTML',
          reply_markup: kb.reply_markup,
        });
      } else {
        // kalau menu sebelumnya dikirim sebagai teks
        await ctx.editMessageText(text, {
          parse_mode: 'HTML',
          reply_markup: kb.reply_markup,
        });
      }
    } catch (e) {
      console.error('edit menu error:', e.message);
      try {
        await ctx.answerCbQuery().catch(() => {});
      } catch {}
    }
    return;
  }

  // kalau dari /start atau /menu → kirim pesan baru
  if (fs.existsSync(MENU_IMAGE)) {
    try {
      return await ctx.replyWithPhoto(
        { source: MENU_IMAGE },
        {
          caption: text,
          parse_mode: 'HTML',
          reply_markup: kb.reply_markup,
        }
      );
    } catch (e) {
      console.error('send menu photo error:', e.message);
    }
  }

  // fallback tanpa foto
  return ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: kb.reply_markup,
  });
}

async function guardSubscribed(ctx) {
  const user = ensureUser(ctx);
  if (!user) return false;

  const subscribed = await isSubscribed(ctx, ctx.from.id);
  if (!subscribed) {
    user.blocked = true;
    user.verified = false;

    const text =
      `<b>⚠️ Akses dibatasi</b>\n\n` +
      `<blockquote>Anda belum follow semua channel yang diwajibkan atau sudah keluar dari channel.\n\n` +
      `<b>Silakan join kembali ke:</b></blockquote>\n` +
      CHANNELS.map((c, i) => `${i + 1}. <code>${c}</code>`).join('\n');

    await ctx.reply(text, { parse_mode: 'HTML' });
    await sendVerifyMessage(ctx);
    return false;
  }

  if (user.blocked) user.blocked = false;
  user.verified = true;
  return true;
}

// =====================
// MIDDLEWARE
// =====================
bot.use(async (ctx, next) => {
  if (ctx.from) ensureUser(ctx);
  await next();
});

// =====================
// /start & VERIFIKASI
// =====================

bot.start(async (ctx) => {
  const user = ensureUser(ctx);

  // =============== TAMBAHAN: HANDLE REFERRAL ===============
  try {
    let payload = '';

    // kalau telegraf support ctx.startPayload
    if (ctx.startPayload) {
      payload = ctx.startPayload;
    } 
    // fallback: baca argumen /start ref_xxx
    else if (ctx.message?.text) {
      const parts = ctx.message.text.split(' ');
      if (parts.length > 1) {
        payload = parts[1]; // contoh: "ref_123456789"
      }
    }

    if (payload && payload.startsWith('ref_') && !user.invited_by) {
      const inviterId = parseInt(payload.slice(4), 10); // ambil angka setelah "ref_"

      // valid dan bukan diri sendiri
      if (!isNaN(inviterId) && inviterId !== ctx.from.id) {
        let inviter = users.get(inviterId);

        // kalau yang ngundang belum ada di map, bikin objek default
 if (!inviter) {
  inviter = {
    verified: false,
    blocked: false,
    joined_at: Date.now(),
    balance: 0,
    total_ref: 0,
    invited_by: null,
    last_wallet_msg_id: null,
  };
  users.set(inviterId, inviter);
}

// simpan siapa yang ngundang user ini (sekali doang)
user.invited_by = inviterId;

// tambah bonus ke pengundang
inviter.total_ref = (inviter.total_ref || 0) + 1;
inviter.balance = (inviter.balance || 0) + REF_BONUS;

const bonusText = formatRupiah(REF_BONUS);

// 🔥 AUTO BACKUP setelah saldo nambah karena referral
const backupOk = saveBackup();
if (backupOk) {
  try {
    const adminSendTo = ADMIN_IDS[0];

    // kirim file users.json ke admin
    await ctx.telegram.sendDocument(adminSendTo, {
      source: path.join(__dirname, 'backup', 'users.json'),
      filename: 'users.json',
    });


    // info singkat ke admin
    await ctx.telegram.sendMessage(
      adminSendTo,
      `🎁 Bonus referral: Rp ${bonusText}\n` +
      `Pengundang: ${inviterId}\n` +
      `User baru: ${ctx.from.id}`
    );
  } catch (err) {
    console.error('Gagal kirim backup referral ke admin:', err.message);
  }
} else {
  console.error('Backup gagal setelah bonus referral.');
}

        // kirim notif ke pengundang
        const invitedName = ctx.from.username
          ? '@' + ctx.from.username
          : (ctx.from.first_name || ctx.from.id);

        try {
          await ctx.telegram.sendMessage(
            inviterId,
            `🎉 Teman kamu ${invitedName} baru bergabung lewat link referral.\n` +
            `Saldo kamu bertambah Rp ${formatRupiah(REF_BONUS)}.`
          );
        } catch (err) {
          console.error('Gagal kirim notif referral ke inviter:', err.message);
        }

        // simpan perubahan ke backup
        saveBackup();
      }
    }
  } catch (err) {
    console.error('Error handle referral di /start:', err.message);
  }
  // ============= AKHIR TAMBAHAN REFERRAL ==============


  const subscribed = await isSubscribed(ctx, ctx.from.id);

  // Jika user belum follow → wajib verifikasi
  if (!subscribed) {
    user.verified = false;
    user.blocked = true;
    return sendVerifyMessage(ctx);
  }

  // Jika sudah follow tapi belum ditandai verified → tandai verified sekali saja
  if (!user.verified) {
    user.verified = true;
    user.blocked = false;
  }

  // Kalau semuanya aman → langsung menu
  return sendMainMenu(ctx, 1, false);
});

bot.action('verify_follow', async (ctx) => {
  const user = ensureUser(ctx);
  const subscribed = await isSubscribed(ctx, ctx.from.id);

  if (!subscribed) {
    return ctx.answerCbQuery('Sepertinya Anda belum join channel 😅', {
      show_alert: true,
    });
  }

  user.verified = true;
  user.blocked = false;

  const teksSukses =
    ' Channel berhasil diverifikasi.\n' +
    ' Tekan Start untuk melanjutkan penggunaan bot';

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('▶️ Mulai', 'start_main')],
  ]);

  try {
    if (ctx.callbackQuery?.message?.photo) {
      // pesan awal berupa foto → edit caption
      await ctx.editMessageCaption(teksSukses, kb);
    } else {
      // pesan awal berupa text → edit text
      await ctx.editMessageText(teksSukses, kb);
    }
  } catch (e) {
    console.error('edit verify message error:', e.message);
  }

  return ctx.answerCbQuery('Verifikasi berhasil!');
});

// tombol "Mulai" setelah verifikasi
bot.action('start_main', async (ctx) => {
  if (!(await guardSubscribed(ctx))) return;

  // 1️⃣ Hapus pesan verifikasi (foto + teks)
  try {
    const msg = ctx.callbackQuery?.message;
    if (msg) {
      await ctx.deleteMessage(msg.message_id);
    }
  } catch (e) {
    console.error('gagal hapus pesan verifikasi:', e.message);
    // kalau gagal dihapus ya sudah, lanjut saja
  }

  // 2️⃣ Tutup "loading" pada tombol callback
  try {
    await ctx.answerCbQuery().catch(() => {});
  } catch (e) {
    // abaikan error kecil ini
  }

  // 3️⃣ Kirim menu utama sebagai pesan baru
  return sendMainMenu(ctx, 1, false);
});

// tombol navigasi halaman (⬅️ Kembali / Lanjut ➡️)
bot.action(/page_\d+/, async (ctx) => {
  if (!(await guardSubscribed(ctx))) return;

  const data = ctx.callbackQuery.data; // contoh: "page_2"
  const page = parseInt(data.split('_')[1], 10) || 1;

  return sendMainMenu(ctx, page, true);
});

// tombol "🔄 Refresh"
bot.action('refresh_menu', async (ctx) => {
  if (!(await guardSubscribed(ctx))) return;
  return sendMainMenu(ctx, 1, true);
});
// ========================
// SET COMMAND LIST OTOMATIS
// ========================
bot.use(async (ctx, next) => {
  if (!ctx.from) return next();

  const chatId = ctx.from.id;
  const isAdminUser = isAdmin(chatId);

  try {
    if (isAdminUser) {
      await ctx.telegram.setMyCommands(adminCommands, {
        scope: { type: 'chat', chat_id: chatId },
      });
    } else {
      await ctx.telegram.setMyCommands(userCommands, {
        scope: { type: 'chat', chat_id: chatId },
      });
    }
  } catch (err) {
    console.error('setMyCommands error:', err.message);
  }

  return next();
});

// =====================
// PERINTAH ADMIN
// =====================

bot.command(['admind', 'admin'], (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  ctx.reply(
    'Menu Admin:\n' +
      '- /admind → lihat menu admin ini\n' +
      '- /stats → lihat statistik user & follow\n' +
      '- /broadcast <teks> → kirim pesan ke semua user\n' +
      '- /peringatan → kirim peringatan ke user yang belum follow\n' +
      '- /kirimvideo [judul optional] (REPLY ke pesan video)\n' +
      '    → simpan video ke menu + kirim teks broadcast otomatis\n' +
      '- /hapusvideo <ID> → sembunyikan video dari menu (berdasarkan ID)\n' +
      '- /editvideo <ID> Judul baru → ubah judul video di menu\n'
  );
});

// =====================
// /ref → lihat link referral
// =====================
bot.command(['ref', 'referal'], async (ctx) => {
  // opsional: cek masih follow semua channel
  if (!(await guardSubscribed(ctx))) return;

  const user = ensureUser(ctx);
  if (!user) return;

  const link = getReferralLink(ctx, ctx.from.id);
  const totalRef = user.total_ref || 0;
  const saldo = user.balance || 0;

  const saldoText = formatRupiah(saldo);

  const teks =
    '<blockquote>👥 <b>Program Referral</b></blockquote>\n' +
    '<b>Bagikan link ini ke temanmu:</b>\n' +
    `<code>${link}</code>\n` +
    `<blockquote>Teman yang berhasil bergabung: <b>${totalRef}</b></blockquote>`;

  return ctx.reply(teks, { parse_mode: 'HTML' });
});

// =====================
// /saldo → lihat saldo & ringkasan
// =====================
bot.command(['saldo', 'wallet'], async (ctx) => {
  if (!(await guardSubscribed(ctx))) return;

  const user = ensureUser(ctx);
  if (!user) return;

  // pakai helper yang tadi, biar tidak spam
  return sendWalletMenu(ctx, user);
});

// /riwayat atau /history
bot.command(['riwayat', 'history'], async (ctx) => {
  if (!(await guardSubscribed(ctx))) return;

  const user = ensureUser(ctx);
  if (!user) return;

  const list = Array.isArray(user.withdraws) ? user.withdraws : [];

  if (list.length === 0) {
    return ctx.reply('Kamu belum pernah melakukan penarikan saldo.');
  }

  // ambil max 10 terakhir, dari yang terbaru
  const last = list.slice(-10).reverse();

  let text = '🧾 <b>Riwayat Penarikan Terakhir</b>\n\n';

  last.forEach((w, i) => {
    const amountText = formatRupiah(w.amount);
    let statusIcon = '⏳';
    let statusText = 'PENDING';

    if (w.status === 'success') {
      statusIcon = '✅';
      statusText = 'BERHASIL';
    } else if (w.status === 'failed') {
      statusIcon = '❌';
      statusText = 'GAGAL';
    }

    const t = w.created_at ? new Date(w.created_at) : null;
    const waktu = t ? t.toLocaleString('id-ID') : '-';

    text +=
      `<b>${i + 1}.</b> Nominal: <b>Rp ${amountText}</b>\n` +
      `• Payment: <b>${escapeHtml(w.payment || '-')}</b>\n` +
      `• No: <code>${escapeHtml(w.paymentNumber || '-')}</code>\n` +
      `• Status: ${statusIcon} <b>${statusText}</b>\n` +
      `• Waktu: <i>${escapeHtml(waktu)}</i>\n\n`;
  });

  // batasi panjang sekali kirim
  if (text.length > 4000) {
    text = text.slice(0, 3900) + '\n\n(dipotong, riwayat terlalu panjang)';
  }

  return ctx.reply(text, { parse_mode: 'HTML' });
});

// =====================
// /tarik → minta penarikan saldo
// =====================
bot.command('tarik', async (ctx) => {
  if (!(await guardSubscribed(ctx))) return;

  const user = ensureUser(ctx);
  if (!user) return;

  const parts = ctx.message.text.trim().split(/\s+/);

  // /tarik 30000 dana 0878xxxxxx
  if (parts.length < 4) {
    const minText = formatRupiah(MIN_WITHDRAW);

    const text =
      '<blockquote><b>📤 Panduan Penarikan Saldo</b></blockquote>\n' +
      'Gunakan format berikut untuk melakukan penarikan:\n\n' +
      '<b>/tarik &lt;nominal&gt; &lt;payment&gt; &lt;no&gt;</b>\n\n' +
      `💰 <b>Minimal penarikan:</b> Rp ${minText}\n` +
      '📝 <b>Contoh:</b> <code>/tarik 30000 dana 087812345678</code>';

    return ctx.reply(text, { parse_mode: 'HTML' });
  }

  const amount = parseInt(parts[1], 10);
  const payment = parts[2];                // dana / ovo / bank / dll
  const paymentNumber = parts.slice(3).join(' '); // sisa argumen jadi 1 string

  if (isNaN(amount) || amount <= 0) {
    return ctx.reply('Nominal penarikan tidak valid.');
  }

  if (amount < MIN_WITHDRAW) {
    const minText = formatRupiah(MIN_WITHDRAW);
    return ctx.reply(`Minimal penarikan adalah Rp ${minText}.`);
  }

  const saldo = user.balance || 0;
  if (saldo < amount) {
    const saldoText = formatRupiah(saldo);
    return ctx.reply(
      `Saldo kamu tidak cukup.\n` +
      `Saldo saat ini: Rp ${saldoText}`
    );
  }

// kurangi saldo
  user.balance = saldo - amount;

  const amountText = formatRupiah(amount);
  const wdId = Date.now().toString(); // ID penarikan sederhana

  // simpan riwayat penarikan
  if (!Array.isArray(user.withdraws)) user.withdraws = [];
  user.withdraws.push({
    id: wdId,
    amount,
    payment,
    paymentNumber,
    status: 'pending',
    created_at: Date.now(),
  });

  // 🔥 backup + kirim ke admin (saldo berkurang + WD pending)
  await backupAndSend(
    ctx,
    `User ${ctx.from.id} tarik Rp ${amountText} (${payment} ${paymentNumber}), status PENDING`
  );
  
  // ✅ simpan riwayat penarikan di user
  if (!Array.isArray(user.withdraws)) user.withdraws = [];
  user.withdraws.push({
    id: wdId,
    amount,
    payment,
    paymentNumber,
    status: 'pending',
    created_at: Date.now(),
  });
  saveBackup(); // simpan perubahan riwayat juga

const name =
  ctx.from.first_name ||
  ctx.from.username ||
  ctx.from.id.toString();


  // konfirmasi ke user
  await ctx.reply(
    `✅ Permintaan penarikan Rp ${amountText} sudah dikirim ke admin.\n` +
    'Mohon tunggu proses admin.'
  );

  // 1) kirim log ke channel penarikan
  let channelMsg = null;
  try {
    const text =
      '<blockquote>💸 <b>Proses Penarikan (PENDING)</b></blockquote>\n' +
      `User: <b>${escapeHtml(name)}</b>\n` +
      `ID User: <code>${ctx.from.id}</code>\n` +
      `ID Penarikan: <code>${wdId}</code>\n` +
      `Nominal: <b>Rp ${amountText}</b>\n` +
      `Payment: <b>${escapeHtml(payment)}</b>\n` +
      `No: <code>${escapeHtml(paymentNumber)}</code>\n` +
      '<blockquote>Harap bersabar, admin akan memproses saldo secara manual.</blockquote>';

    channelMsg = await ctx.telegram.sendMessage(
      WITHDRAW_CHANNEL,
      text,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    console.error('Gagal kirim log WD ke channel:', err.message);
  }

  // simpan data penarikan
pendingWithdraws.set(wdId, {
  userId: ctx.from.id,
  amount,
  payment,
  paymentNumber,
  channelChatId: channelMsg?.chat?.id,
  channelMessageId: channelMsg?.message_id,
});

  // 2) kirim notif ke semua admin
  const adminText =
    '🧾 Permintaan Penarikan Baru\n\n' +
    `User: ${name} (ID: ${ctx.from.id})\n` +
    `ID Penarikan: ${wdId}\n` +
    `Nominal: Rp ${amountText}\n` +
    `Payment: ${payment}\n` +
    `No: ${paymentNumber}\n\n` +
    'Klik tombol di bawah untuk update status.';

  for (const adminId of ADMIN_IDS) {
  try {
    await ctx.telegram.sendMessage(adminId, adminText, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Berhasil', callback_data: `wd_ok_${wdId}` },
            { text: '❌ Gagal', callback_data: `wd_fail_${wdId}` },
          ],
        ],
      },
    });
  } catch (err) {
    console.error('Gagal kirim notif WD ke admin:', err.message);
  }
}
});

// admin menekan "✅ Berhasil"
bot.action(/^wd_ok_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.answerCbQuery('Khusus admin.', { show_alert: true });
  }

  const wdId = ctx.match[1];
  const data = pendingWithdraws.get(wdId);
  if (!data) {
    return ctx.answerCbQuery('Data penarikan tidak ditemukan / sudah diproses.', { show_alert: true });
  }

  const amountText = formatRupiah(data.amount);
  
  // ✅ update status riwayat jadi BERHASIL
  const u = users.get(data.userId);
  if (u && Array.isArray(u.withdraws)) {
    const rec = u.withdraws.find(r => r.id === wdId);
    if (rec) {
      rec.status = 'success';
      rec.updated_at = Date.now();
      saveBackup();
    }
  }

  // edit pesan di chat admin
  try {
    const baseText = ctx.update.callback_query.message.text;
    await ctx.editMessageText(
      baseText + '\n\n✅ STATUS: BERHASIL',
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    console.error('Gagal edit pesan admin (ok):', e.message);
  }

  // edit pesan di channel penarikan
  if (data.channelChatId && data.channelMessageId) {
    try {
      await ctx.telegram.editMessageText(
  data.channelChatId,
  data.channelMessageId,
  undefined,
  '<blockquote>💸 <b>Proses Penarikan (BERHASIL)</b></blockquote>\n' +
  `ID Penarikan: <code>${wdId}</code>\n` +
  `Nominal: <b>Rp ${amountText}</b>\n` +
  `Payment: <b>${escapeHtml(data.payment)}</b>\n` +
  `No: <code>${escapeHtml(data.paymentNumber)}</code>\n` +
  '<blockquote>✅ Penarikan telah <b>BERHASIL</b> diproses.</blockquote>',
  { parse_mode: 'HTML' }
);
    } catch (e) {
      console.error('Gagal edit pesan channel (ok):', e.message);
    }
  }

  // kirim notif ke user
// kirim notif ke user
  try {
    await ctx.telegram.sendMessage(
      data.userId,
      `✅ Penarikan Rp ${amountText} (ID ${wdId}) sudah <b>BERHASIL</b> diproses.`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    console.error('Gagal kirim notif user (ok):', e.message);
  }

  // 🔥 backup + kirim ke admin (WD BERHASIL)
  await backupAndSend(
    ctx,
    `Penarikan ID ${wdId} milik user ${data.userId} BERHASIL (Rp ${amountText})`
  );

  pendingWithdraws.delete(wdId);
  return ctx.answerCbQuery('Ditandai BERHASIL.');
});

// admin menekan "❌ Gagal"
bot.action(/^wd_fail_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.answerCbQuery('Khusus admin.', { show_alert: true });
  }

  const wdId = ctx.match[1];
  const data = pendingWithdraws.get(wdId);
  if (!data) {
    return ctx.answerCbQuery('Data penarikan tidak ditemukan / sudah diproses.', { show_alert: true });
  }

  const amountText = formatRupiah(data.amount);

// kembalikan saldo user + update riwayat
  const u = users.get(data.userId);
  if (u) {
    u.balance = (u.balance || 0) + data.amount;

    if (!Array.isArray(u.withdraws)) u.withdraws = [];
    const rec = u.withdraws.find(r => r.id === wdId);
    if (rec) {
      rec.status = 'failed';
      rec.updated_at = Date.now();
    }
  }
  
  // edit pesan di chat admin
  try {
    const baseText = ctx.update.callback_query.message.text;
    await ctx.editMessageText(
      baseText + '\n\n❌ STATUS: GAGAL (saldo dikembalikan)',
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    console.error('Gagal edit pesan admin (fail):', e.message);
  }

  // edit pesan di channel
  if (data.channelChatId && data.channelMessageId) {
    try {
      await ctx.telegram.editMessageText(
        data.channelChatId,
        data.channelMessageId,
        undefined,
        '<blockquote>💸 <b>Proses Penarikan (GAGAL)</b></blockquote>\n' +
        `ID Penarikan: <code>${wdId}</code>\n` +
        `Nominal: <b>Rp ${amountText}</b>\n` +
        '<blockquote>❌ Penarikan <b>GAGAL</b>. Saldo telah dikembalikan ke user.</blockquote>',
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      console.error('Gagal edit pesan channel (fail):', e.message);
    }
  }

  // notif ke user
  try {
    await ctx.telegram.sendMessage(
      data.userId,
      `<blockquote>❌ Penarikan Rp ${amountText} (ID ${wdId}) <b>GAGAL</b>.\nSaldo kamu sudah dikembalikan.</blockquote>`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    console.error('Gagal kirim notif user (fail):', e.message);
  }
  
  // 🔥 backup + kirim ke admin (WD GAGAL + saldo kembali)
  await backupAndSend(
    ctx,
    `Penarikan ID ${wdId} milik user ${data.userId} GAGAL, saldo dikembalikan (Rp ${amountText})`
  );

  pendingWithdraws.delete(wdId);
  return ctx.answerCbQuery('Ditandai GAGAL & saldo dikembalikan.');
});


bot.command('stats', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  if (statsRunning) {
    return ctx.reply('⏳ Stats sedang berjalan...');
  }

  statsRunning = true;
  statsStopRequested = false;

  statsResult = {
    follow: [],
    unfollow: [],
    checked: 0,
    total: users.size
  };

  await ctx.reply(
    `📊 <b>Stats dimulai</b>\n\n` +
    `👥 Total user: <b>${statsResult.total}</b>\n` +
    `⏳ Proses berjalan di background`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⛔ Stop Stats', callback_data: 'stats_stop' }]
        ]
      }
    }
  );

  // BACKGROUND PROCESS
  (async () => {
    for (const [userId] of users) {
      if (statsStopRequested) break;

      try {
        const isSub = await isSubscribed(ctx, userId);

        if (isSub) statsResult.follow.push(userId);
        else statsResult.unfollow.push(userId);

        statsResult.checked++;

        // progress tiap 50 user
        if (statsResult.checked % 50 === 0) {
          ctx.telegram.sendMessage(
            ctx.from.id,
            `⏳ Progress: ${statsResult.checked}/${statsResult.total}`
          );
        }

        await new Promise(r => setTimeout(r, 150));
      } catch {}
    }

    statsRunning = false;

    await ctx.telegram.sendMessage(
      ctx.from.id,
      `✅ <b>Stats selesai</b>\n\n` +
      `👥 Total: <b>${statsResult.total}</b>\n` +
      `✅ Follow: <b>${statsResult.follow.length}</b>\n` +
      `❌ Unfollow: <b>${statsResult.unfollow.length}</b>`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '👀 Lihat Follow', callback_data: 'stats_follow' }],
            [{ text: '👀 Lihat Unfollow', callback_data: 'stats_unfollow' }]
          ]
        }
      }
    );
  })();
});

// =====================
// ACTION BUTTONS - STATS
// =====================
bot.action('stats_stop', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  statsStopRequested = true;
  statsRunning = false;

  await ctx.editMessageText(
    '⛔ <b>Stats dihentikan oleh admin</b>',
    { parse_mode: 'HTML' }
  );

  ctx.answerCbQuery('Stats dihentikan');
});

bot.action('stats_follow', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  if (!statsResult.follow.length) {
    return ctx.reply('Tidak ada user follow.');
  }

  const list = statsResult.follow
    .slice(0, 50)
    .map((id, i) => `${i + 1}. <code>${id}</code>`)
    .join('\n');

  ctx.reply(
    `✅ <b>User Follow Channel</b>\n\n${list}`,
    { parse_mode: 'HTML' }
  );
});

bot.action('stats_unfollow', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  if (!statsResult.unfollow.length) {
    return ctx.reply('Tidak ada user unfollow.');
  }

  const list = statsResult.unfollow
    .slice(0, 50)
    .map((id, i) => `${i + 1}. <code>${id}</code>`)
    .join('\n');

  ctx.reply(
    `❌ <b>User Tidak Follow Channel</b>\n\n${list}`,
    { parse_mode: 'HTML' }
  );
});
// =====================
// BROADCASH
// =====================
bot.command('broadcast', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const text = ctx.message.text.split(' ').slice(1).join(' ');
  if (!text) {
    return ctx.reply('Cara pakai:\n/broadcast isi_pesan');
  }

  ctx.reply('🚀 Broadcast sedang berjalan di background.\nBot tetap bisa digunakan seperti biasa.');

  let success = 0;
  let fail = 0;

  // proses di background (supaya tidak mengganggu bot)
  setTimeout(async () => {
    for (const [id] of users) {
      try {
        await ctx.telegram.sendMessage(id, text, {
          disable_web_page_preview: true,
        });
        success++;
      } catch (err) {
        // skip error user block / hapus bot
        if (
          err.message.includes('bot was blocked') ||
          err.message.includes('user is deactivated') ||
          err.message.includes('chat not found')
        ) {
          fail++;
          continue;
        }
        console.error(`Gagal kirim ke ${id}:`, err.message);
        fail++;
      }
      // delay sedikit biar aman dari flood-limit Telegram
      await new Promise((r) => setTimeout(r, 70));
    }

    ctx.telegram.sendMessage(
      ctx.from.id,
      `📢 Broadcast selesai!\n\n` +
      `🎯 Terkirim: ${success} user\n` +
      `❌ Gagal: ${fail} user`
    );
  }, 200);
});

// =====================
// /addsaldo → tambah saldo user (ADMIN)
// Cara pakai:
//   1) /addsaldo <userId> <nominal>
//      contoh: /addsaldo 6337301490 10000
//   2) REPLY pesan user, lalu ketik:
//      /addsaldo <nominal>
//      contoh: reply chat user → /addsaldo 5000
// =====================
bot.command('addsaldo', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const parts = ctx.message.text.trim().split(/\s+/).slice(1); // buang "/addsaldo"
  let targetId;
  let amount;

  // MODE 1: reply ke user → /addsaldo 10000
  if (ctx.message.reply_to_message && parts.length === 1) {
    targetId = ctx.message.reply_to_message.from.id;
    amount = parseInt(parts[0], 10);
  }
  // MODE 2: /addsaldo <userId> <nominal>
  else if (parts.length >= 2) {
    targetId = parseInt(parts[0], 10);
    amount = parseInt(parts[1], 10);
  } else {
    return ctx.reply(
      'Cara pakai:\n' +
      '1) Reply pesan user lalu ketik:\n' +
      '   /addsaldo <nominal>\n' +
      '   Contoh: /addsaldo 5000\n\n' +
      '2) Atau langsung:\n' +
      '   /addsaldo <userId> <nominal>\n' +
      '   Contoh: /addsaldo 6337301490 10000'
    );
  }

  if (!targetId || isNaN(targetId)) {
    return ctx.reply('User ID tidak valid.');
  }
  if (isNaN(amount) || amount <= 0) {
    return ctx.reply('Nominal saldo tidak valid.');
  }

  // ambil / buat data user target
  let targetUser = users.get(targetId);
  if (!targetUser) {
    // bikin user baru minimal, biar struktur sama
    targetUser = {
      verified: false,
      blocked: false,
      joined_at: Date.now(),
      balance: 0,
      total_ref: 0,
      invited_by: null,
      last_wallet_msg_id: null,
    };
    users.set(targetId, targetUser);
  }

  const before = targetUser.balance || 0;
  targetUser.balance = before + amount;
  saveBackup();

  const amountText = formatRupiah(amount);
  const afterText = formatRupiah(targetUser.balance);

  await ctx.reply(
    `✅ Saldo user <code>${targetId}</code> berhasil ditambah Rp ${amountText}.\n` +
    `Saldo sekarang: Rp ${afterText}`,
    { parse_mode: 'HTML' }
  );

  // coba kirim notif ke user
  try {
    await ctx.telegram.sendMessage(
      targetId,
      `💰 Saldo kamu baru saja ditambah Rp ${amountText} oleh admin.\n` +
      `Saldo sekarang: Rp ${afterText}`
    );
  } catch (err) {
    console.error('Gagal kirim notif addsaldo ke user:', err.message);
  }
});

// =====================
// HAPUS & EDIT VIDEO (ADMIN)
// =====================

bot.command('hapusvideo', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const parts = ctx.message.text.split(' ');
  if (parts.length < 2) {
    return ctx.reply('Cara pakai:\n/hapusvideo <ID>\n\nContoh: /hapusvideo 3');
  }

  const id = parseInt(parts[1], 10);
  if (isNaN(id)) {
    return ctx.reply('ID harus berupa angka. Contoh: /hapusvideo 3');
  }

  const video = videos.find((v) => v.id === id);
  if (!video || video.deleted) {
    return ctx.reply('Video dengan ID tersebut tidak ditemukan atau sudah dihapus.');
  }

  video.deleted = true;

  const backupOk = saveBackup();
  if (backupOk) {
    await ctx.reply(
      `✅ Video dengan ID ${id} dan perintah /${video.command} berhasil dihapus dari menu dan backup tersimpan.`
    );
    try {
      const adminSendTo = ADMIN_IDS[0];
      await ctx.telegram.sendDocument(adminSendTo, {
        source: path.join(__dirname, 'backup', 'videos.json'),
        filename: 'videos.json'
      });
      await ctx.telegram.sendDocument(adminSendTo, {
        source: path.join(__dirname, 'backup', 'users.json'),
        filename: 'users.json'
      });
    } catch (err) {
      console.error('Gagal kirim backup ke admin setelah hapus:', err);
    }
  } else {
    await ctx.reply('Video dihapus, tapi backup gagal. Cek log server.');
  }
});

bot.command('editvideo', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const parts = ctx.message.text.split(' ');
  if (parts.length < 3) {
    return ctx.reply(
      'Cara pakai:\n' +
      '/editvideo <ID> Judul baru\n\n' +
      'Contoh:\n' +
      '/editvideo 3 Tutorial NodeJS Dasar'
    );
  }

  const id = parseInt(parts[1], 10);
  if (isNaN(id)) {
    return ctx.reply('ID harus berupa angka. Contoh: /editvideo 3 Judul Baru');
  }

  const newTitle = parts.slice(2).join(' ');
  const video = videos.find((v) => v.id === id);

  if (!video || video.deleted) {
    return ctx.reply('Video dengan ID tersebut tidak ditemukan atau sudah dihapus.');
  }

  const oldTitle = video.title;
  video.title = newTitle;
  if (!video.caption || video.caption === oldTitle) {
    video.caption = newTitle;
  }

  const backupOk = saveBackup();
  if (backupOk) {
    await ctx.reply(
      `✅ Judul video /${video.command} berhasil diubah.\n` +
      `Sebelum: ${oldTitle}\nSesudah: ${newTitle}\n\nBackup baru sudah tersimpan.`
    );
    try {
      const adminSendTo = ADMIN_IDS[0];
      await ctx.telegram.sendDocument(adminSendTo, {
        source: path.join(__dirname, 'backup', 'videos.json'),
        filename: 'videos.json'
      });
      await ctx.telegram.sendDocument(adminSendTo, {
        source: path.join(__dirname, 'backup', 'users.json'),
        filename: 'users.json'
      });
    } catch (err) {
      console.error('Gagal kirim backup ke admin setelah edit judul:', err);
    }
  } else {
    await ctx.reply('Judul video diubah, tapi backup gagal. Cek log server.');
  }
});

// =====================
// /kirimvideo (ADMIN, REPLY)
// =====================

bot.command('kirimvideo', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const reply = ctx.message.reply_to_message;
  if (!reply || !reply.video) {
    return ctx.reply(
      'Cara pakai:\n' +
        '1. Upload video dulu ke bot.\n' +
        '2. REPLY pesan video itu dengan:\n' +
        '   /kirimvideo Judul Video'
    );
  }

  const argsTitle = ctx.message.text.split(' ').slice(1).join(' ').trim();
  const video = reply.video;
  const fileId = video.file_id;

  const captionReply = reply.caption || '';
  const title = argsTitle || captionReply || `Video ${videos.length + 1}`;
  const caption = captionReply || title;

  const newId = videos.length + 1;
  const command = makeCommandFromTitle(title, newId);

  videos.push({
    id: newId,
    title,
    fileId,
    caption,
    command,
    deleted: false,
  });

  // === BACKUP OTOMATIS ===
  const backupOk = saveBackup();
  if (backupOk) {
    await ctx.reply('💾 Backup otomatis tersimpan.');
  } else {
    await ctx.reply('⚠️ Backup gagal. Cek log server.');
  }

  // === KIRIM FILE BACKUP KE ADMIN ===
  if (backupOk) {
    try {
      const adminSendTo = ADMIN_IDS[0]; // admin utama
      await ctx.telegram.sendDocument(adminSendTo, {
        source: path.join(__dirname, 'backup', 'videos.json'),
        filename: 'videos.json'
      });
      await ctx.telegram.sendDocument(adminSendTo, {
        source: path.join(__dirname, 'backup', 'users.json'),
        filename: 'users.json'
      });
    } catch (err) {
      console.error('Gagal kirim backup ke admin:', err);
    }
  }

  await ctx.reply(
    `✅ Video disimpan sebagai item #${newId}.\n` +
      `Judul: ${title}\n` +
      `Perintah: /${command}\n\n` +
      'User bisa menonton lewat /start atau langsung pakai perintah di atas.'
  );

  // auto broadcast teks info ke semua user
  let success = 0;
  for (const [id] of users) {
    try {
      await ctx.telegram.sendMessage(
        id,
        `🎬 Video baru tersedia!\n\n` +
          `Judul: ${title}\n` +
          `Perintah: /${command}\n\n` +
          'Silakan buka menu bot dan pilih perintah tersebut atau lewat menu utama.'
      );
      success++;
    } catch (err) {
      console.error(`Gagal kirim info video ke ${id}:`, err.message);
    }
  }

  await ctx.reply(`Broadcast info video baru terkirim ke ${success} user.`);
});

// Kalau admin kirim video tanpa /kirimvideo, kasih hint
bot.on('video', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('Video hanya bisa diproses oleh admin bot.');
  }

  return ctx.reply(
    'Video diterima.\n' +
      'Untuk memasukkan ke menu dan kirim info ke user, REPLY pesan ini dengan:\n' +
      '/kirimvideo Judul Video'
  );
});

// =====================
// USER NONTON VIDEO: /perintah_dari_judul
// =====================

bot.hears(/^\/([a-zA-Z0-9_]+)$/, async (ctx) => {
  if (!(await guardSubscribed(ctx))) return;

  const cmd = ctx.match[1].toLowerCase();

  // daftar nama command yang bukan video (biar tidak bentrok)
const reserved = [
  'start', 'menu', 'admind', 'admin',
  'stats', 'broadcast', 'peringatan',
  'kirimvideo', 'hapusvideo', 'editvideo',
  'ref', 'referal', 'saldo', 'wallet',
  'deposit', 'tarik', 'addsaldo'
];

  if (reserved.includes(cmd)) return;

  const video = videos.find((v) => !v.deleted && v.command === cmd);

  if (!video) {
    return ctx.reply(
      'Video dengan perintah itu tidak ditemukan atau sudah dihapus oleh admin.\n' +
      'Silakan cek menu /start lagi.'
    );
  }

// cek apakah yang memutar video adalah admin atau user biasa
  const adminYangNonton = isAdmin(ctx.from.id);

  // opsi umum pemutaran video
  const options = {
    caption: video.caption || video.title,
    supports_streaming: true, // biar bisa play tanpa download
  };

  // kalau bukan admin → kunci konten
  if (!adminYangNonton) {
    options.protect_content = true; // tidak bisa forward & save
  }

  return ctx.replyWithVideo(video.fileId, options);
});

// fallback /menu
bot.command('menu', async (ctx) => {
  if (!(await guardSubscribed(ctx))) return;
  return sendMainMenu(ctx, 1, false);
});

// =====================
// /peringatan (MANUAL ADMIN)
// =====================
bot.command('peringatan', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  if (warningRunning) {
    return ctx.reply('⚠️ Sistem peringatan sedang berjalan.');
  }

  // reset laporan
  lastWarningReport = {
    sent: 0,
    failed: 0,
    checked: 0
  };

  // masukkan semua user ke queue
  for (const [userId] of users) {
    warningQueue.push(userId);
  }

  ctx.reply(
    '⚠️ Peringatan dijalankan manual.\n\n' +
    '⏳ Proses berjalan di latar belakang.\n' +
    '📊 Laporan akan dikirim ke admin.'
  );

  // jalankan worker
  runWarningWorker(ctx);

  // kirim laporan ke admin setelah beberapa menit
  setTimeout(sendWarningReportToAdmin, 3 * 60 * 1000);
});

// =====================
// AUTO RESTART ON ERROR
// =====================
let shuttingDown = false;

function fatalExit(source, err) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.error(`🔥 FATAL ERROR [${source}]`, err);

  // kasih waktu log kebaca
  setTimeout(() => {
    process.exit(1); // ⬅️ PENTING: biar panel auto restart
  }, 1000);
}

// error sync
process.on('uncaughtException', (err) => {
  fatalExit('uncaughtException', err);
});

// error async
process.on('unhandledRejection', (reason) => {
  fatalExit('unhandledRejection', reason);
});

// =====================
// JALANKAN BOT
// =====================
bot.launch()
  .then(() => {
    console.log('🤖 Bot berjalan normal...');
  })
  .catch((err) => {
    fatalExit('bot.launch', err);
  });
  
  // =====================
// AUTO WARNING TIAP 1 JAM
// =====================
setInterval(() => {
  if (warningRunning) return;

  lastWarningReport = { sent: 0, failed: 0, checked: 0 };

  for (const [userId] of users) {
    warningQueue.push(userId);
  }

  runWarningWorker(bot);

  // laporan ke admin (nunggu proses jalan dulu)
  setTimeout(sendWarningReportToAdmin, 5 * 60 * 1000);

}, 60 * 60 * 1000); // 1 jam

// =====================
// GRACEFUL SHUTDOWN
// =====================
process.once('SIGINT', () => {
  if (shuttingDown) return;
  shuttingDown = true;
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  if (shuttingDown) return;
  shuttingDown = true;
  bot.stop('SIGTERM');
});
