# Bebeq Donate Relay

Penghubung antara platform donasi (Saweria, BagiBagi, SociaBuzz, Tako, Trakteer)
dengan sistem donasi Bebeq di Roblox.

Setiap pembeli memasang **salinannya sendiri** di akun Cloudflare masing-masing.
Data donasi, kunci, dan database tidak pernah bercampur antar pembeli.

---

## Pasang (sekali, sekitar 3 menit)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bebeqi19/bebeq-donate-relay)

Tombol di atas akan:

1. Menyalin repo ini ke akun GitHub kamu
2. Membuat database D1 baru di akun Cloudflare kamu
3. Membuat tabelnya secara otomatis
4. Men-deploy Worker dan memberi kamu sebuah URL

Saat proses berjalan, kamu akan diminta mengisi tiga kata sandi. Isi ketiganya
dengan teks acak yang berbeda-beda:

| Isian | Dipakai untuk |
|---|---|
| `SECRET` | Kata sandi webhook platform donasi |
| `ROBLOX_KEY` | Kunci yang dibaca game Roblox |
| `ADMIN_KEY` | Kata sandi halaman admin |

> Cara membuat teks acak: buka <https://www.random.org/strings/> atau ketik saja
> huruf dan angka sembarang sepanjang 20-30 karakter.

---

## Setelah deploy

Cloudflare memberi kamu URL seperti `https://bebeq-donate-relay.NAMAKAMU.workers.dev`.

**1. Sambungkan ke Roblox.** Buka `ServerScriptService > BebeqSwrSystem > BebeqSwrConfig`, lalu isi:

```lua
Config.WEBHOOK_URL = "https://bebeq-donate-relay.NAMAKAMU.workers.dev/"
Config.WEBHOOK_KEY = "isi sama dengan ROBLOX_KEY"
```

Pastikan juga **Allow HTTP Requests** dan **API Services** aktif di Game Settings.

**2. Sambungkan platform donasi.** Di pengaturan webhook Saweria (atau platform lain), isi:

```
https://bebeq-donate-relay.NAMAKAMU.workers.dev/?source=saweria&key=ISI_SECRET
```

Ganti `source=` sesuai platformnya: `saweria`, `bagibagi`, `sociabuzz`, `tako`, atau `trakteer`.
Ganti `ISI_SECRET` dengan nilai **SECRET** yang kamu isi saat deploy.

> Nama parameternya `key=`, bukan `secret=`. Kalau salah, Worker menolak webhook
> dengan `{"status":"failed","error":"unauthorized"}` dan donasi tidak pernah masuk.

**3. Cek.** Buka URL Worker di browser, masukkan `ADMIN_KEY`. Dari situ kamu bisa
mengirim donasi uji coba tanpa mengeluarkan uang sungguhan.

---

## Kalau donasi tidak masuk

**Buka URL Worker di browser dan muncul `{"status":"failed","error":"unauthorized"}`.**
Itu normal. Membuka URL di browser adalah permintaan GET, dan semua GET dianggap
datang dari game Roblox sehingga diperiksa dengan `ROBLOX_KEY`. Webhook platform
donasi memakai POST, bukan GET. Untuk melihat isinya, pakai `?admin`.

**Donasi manual dari halaman admin masuk, tapi donasi asli dari Saweria tidak.**
URL webhook di Saweria kemungkinan besar masih memakai `secret=`. Ganti menjadi
`key=` seperti pada langkah 2, lalu kirim donasi uji lagi.

**Masih belum masuk juga.** Ubah `LOG_RAW` menjadi `"1"` di `wrangler.jsonc`, deploy
ulang, lalu kirim donasi uji. Payload mentah dari platform tersimpan di tabel `logs`
sehingga bisa diperiksa. Kembalikan ke `"0"` setelah selesai supaya hemat kuota.

**Donasi ada di halaman admin, tapi notifikasi di game tidak muncul.** Jalankan game
lebih dulu, baru kirim donasi. Donasi yang masuk sebelum server menyala tidak
diumumkan (biar server baru tidak menyemburkan notifikasi lama). Untuk memutarnya
lagi, pakai tombol Replay di panel admin dalam game.

---

## Ganti kata sandi nanti

Cloudflare Dashboard → Workers & Pages → pilih Worker → Settings → Variables and Secrets.

## Batas gratis

Satu game aktif memakai sekitar 22% dari kuota harian Workers Free. Untuk
pemakaian normal, kamu tidak perlu membayar apa pun.
