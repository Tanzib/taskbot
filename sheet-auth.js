// Keeps the bot's WhatsApp login in your Google Drive (through the sheet's web app),
// so it survives restarts on free cloud hosts that wipe their disk (e.g. Render).
import zlib from 'zlib';
import { initAuthCreds, BufferJSON, proto } from 'baileys';

export async function useSheetAuthState(sheet, log) {
  let data = { creds: null, keys: {}, extra: {} };
  const r = await sheet({ action: 'authLoad' });
  if (r.data) {
    try {
      const json = zlib.gunzipSync(Buffer.from(r.data, 'base64')).toString('utf8');
      data = JSON.parse(json, BufferJSON.reviver);
      log('🔑 WhatsApp login restored from Google Drive');
    } catch (e) { log('⚠️ Saved login unreadable, starting fresh:', e.message); }
  }
  if (!data.creds) data.creds = initAuthCreds();
  data.keys = data.keys || {};
  data.extra = data.extra || {};

  let timer = null;
  let dirty = false;
  let chain = Promise.resolve();
  const doSave = async () => {
    if (!dirty) return;
    dirty = false;
    const blob = zlib.gzipSync(JSON.stringify(data, BufferJSON.replacer)).toString('base64');
    await sheet({ action: 'authSave', data: blob });
  };
  const schedule = (ms = 5000) => {
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(() => { chain = chain.then(doSave).catch(e => { dirty = true; log('⚠️ Login save failed (will retry):', e.message); schedule(30000); }); }, ms);
  };

  const state = {
    creds: data.creds,
    keys: {
      get: async (type, ids) => {
        const bucket = data.keys[type] || {};
        const out = {};
        for (const id of ids) {
          let v = bucket[id];
          if (v && type === 'app-state-sync-key') v = proto.Message.AppStateSyncKeyData.fromObject(v);
          if (v !== undefined && v !== null) out[id] = v;
        }
        return out;
      },
      set: async (changes) => {
        for (const type in changes) {
          data.keys[type] = data.keys[type] || {};
          for (const id in changes[type]) {
            const v = changes[type][id];
            if (v) data.keys[type][id] = v; else delete data.keys[type][id];
          }
        }
        schedule();
      },
    },
  };

  return {
    state,
    saveCreds: async () => { data.creds = state.creds; schedule(1000); },
    extra: data.extra,
    touchExtra: () => schedule(15000),
    flush: async () => { clearTimeout(timer); chain = chain.then(doSave); await chain.catch(() => {}); },
    reset: async () => {
      data = { creds: initAuthCreds(), keys: {}, extra: data.extra };
      dirty = true;
      await doSave().catch(() => {});
    },
  };
}
