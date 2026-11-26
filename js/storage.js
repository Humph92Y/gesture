// 테스트 보고서 저장 (브라우저 IndexedDB). 브라우저를 바꾸거나 기록을 지우면 사라지므로 "내보내기"로 파일 보관.
const DB = 'airdrum', STORE = 'reports';
let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    } catch (e) { rej(e); }
  });
  return dbp;
}
const mem = new Map(); // IndexedDB 를 못 쓰는 환경용
async function tx(mode, fn) {
  try {
    const db = await open();
    return await new Promise((res, rej) => {
      const t = db.transaction(STORE, mode); const st = t.objectStore(STORE);
      const out = fn(st);
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
      t.onerror = () => rej(t.error);
    });
  } catch { return null; }
}
export async function saveReport(rep) { mem.set(rep.id, rep); await tx('readwrite', st => st.put(rep)); }
export async function deleteReport(id) { mem.delete(id); await tx('readwrite', st => st.delete(id)); }
export async function listReports() {
  const r = await tx('readonly', st => st.getAll());
  const all = Array.isArray(r) ? r : [...mem.values()];
  return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
export function lsGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
export function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장 불가 환경 */ } }

export function download(name, obj) {
  const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
