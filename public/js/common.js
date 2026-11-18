/* GezyDafnil — helper bersama semua halaman. */
async function api(path, opt = {}) {
  const r = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(opt.headers || {}) },
    ...opt,
  });
  if (r.status === 401) {
    location.href = "/login.html";
    throw new Error("Belum login");
  }
  let data = null;
  try { data = await r.json(); } catch { /* bukan JSON */ }
  if (!r.ok) throw new Error((data && data.error) || ("Gagal (" + r.status + ")"));
  return data;
}

async function butuhLogin() {
  try {
    const d = await api("/api/me");
    const el = document.getElementById("nama-pengguna");
    if (el) el.textContent = d.user.username + " (" + d.user.role + ")" + (d.user.guru_nama ? " — " + d.user.guru_nama : "");
    const adminLink = document.getElementById("menu-admin");
    if (adminLink && d.user.role !== "admin") adminLink.style.display = "none";
    const masterLink = document.getElementById("menu-master");
    if (masterLink && d.user.role !== "admin") masterLink.style.display = "none";
    return d.user;
  } catch {
    location.href = "/login.html";
    throw new Error("Belum login");
  }
}

async function keluar() {
  await fetch("/api/logout", { method: "POST" });
  location.href = "/login.html";
}

function el(id) { return document.getElementById(id); }
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function angka(v) {
  return v === null || v === undefined || v === "" ? "" : String(v);
}
function simpanLokal(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
function bacaLokal(k, def) {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; }
}
