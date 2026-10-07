import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://mbmxfyslftdeobecbske.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_wMp1B0NTMZJQ89sr6-Xkhg_CBvkeX7j';
const SYNC_TABLE = 'speis_sync_state';
const SYNC_USER_KEY = 'speis_cloud_user_v1';
const SYNC_DIRTY_KEY = 'speis_cloud_dirty_v1';
const PROFILE_NAMES = ['Josep', 'Tudon'];

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

let currentSession = null;
let cloudReady = false;
let handledUserId = null;
let lastCloudUpdatedAt = '';
let pushTimer = null;
let pushInFlight = false;
let pushAgain = false;

function readJson(key){
  try{
    const value = localStorage.getItem(key);
    return value === null ? null : JSON.parse(value);
  }catch(error){ return null; }
}

function clone(value){
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function captureLocalSnapshot(){
  const profiles = {};
  PROFILE_NAMES.forEach(profile => {
    profiles[profile] = {
      history: readJson(`speis_${profile}_history_v2`),
      notes: readJson(`speis_${profile}_notes`),
      dirToggle: readJson(`speis_${profile}_dirtoggle`),
      answerMode: localStorage.getItem(`speis_${profile}_monument_answer_mode`)
    };
  });
  return {
    version: 1,
    profiles,
    shared: {
      editableData: readJson('speis_quiz_editable_data_v1'),
      monumentos: readJson('speis_monumentos_custom_v1'),
      pins: readJson('speis_quiz_map_pins_v1')
    }
  };
}

function normalizeSnapshot(value){
  const snapshot = value && typeof value === 'object' ? clone(value) : {};
  snapshot.version = 1;
  snapshot.profiles = snapshot.profiles && typeof snapshot.profiles === 'object' ? snapshot.profiles : {};
  PROFILE_NAMES.forEach(profile => {
    const data = snapshot.profiles[profile];
    snapshot.profiles[profile] = data && typeof data === 'object' ? data : {};
  });
  snapshot.shared = snapshot.shared && typeof snapshot.shared === 'object' ? snapshot.shared : {};
  return snapshot;
}

function hasMeaningfulData(snapshot){
  const data = normalizeSnapshot(snapshot);
  const profileHasData = PROFILE_NAMES.some(profile => {
    const p = data.profiles[profile];
    const history = p.history && Object.values(p.history).some(category =>
      category && Object.values(category).some(result => Number(result?.ok) > 0 || Number(result?.fail) > 0 || Number(result?.streak) > 0)
    );
    const notes = p.notes && Object.values(p.notes).some(note => String(note || '').trim());
    const preferences = p.answerMode === 'select' || (p.dirToggle && Object.values(p.dirToggle).some(Boolean));
    return history || notes || preferences;
  });
  const shared = data.shared;
  return !!(profileHasData ||
    (shared.pins && Object.keys(shared.pins).length) ||
    (shared.editableData && Object.keys(shared.editableData).length) ||
    (Array.isArray(shared.monumentos) && shared.monumentos.length));
}

function mergeHistory(remote, local){
  const merged = clone(remote) || {};
  Object.entries(local || {}).forEach(([category, records]) => {
    if(!records || typeof records !== 'object') return;
    merged[category] = merged[category] && typeof merged[category] === 'object' ? merged[category] : {};
    Object.entries(records).forEach(([item, result]) => {
      const previous = merged[category][item] || {};
      merged[category][item] = {
        ok: Math.max(Number(previous.ok) || 0, Number(result?.ok) || 0),
        fail: Math.max(Number(previous.fail) || 0, Number(result?.fail) || 0),
        streak: Math.max(Number(previous.streak) || 0, Number(result?.streak) || 0)
      };
    });
  });
  return merged;
}

function mergeItemArrays(remote, local){
  if(!Array.isArray(remote)) return clone(local);
  if(!Array.isArray(local)) return clone(remote);
  const result = new Map();
  remote.forEach((item, index) => result.set(item?.id || item?.n || `remote-${index}`, clone(item)));
  local.forEach((item, index) => result.set(item?.id || item?.n || `local-${index}`, clone(item)));
  return [...result.values()];
}

function mergeEditableData(remote, local){
  const merged = clone(remote) || {};
  Object.entries(local || {}).forEach(([category, items]) => {
    merged[category] = mergeItemArrays(merged[category], items);
  });
  return merged;
}

function mergeSnapshots(remoteValue, localValue){
  const remote = normalizeSnapshot(remoteValue);
  const local = normalizeSnapshot(localValue);
  const merged = normalizeSnapshot(remote);
  PROFILE_NAMES.forEach(profile => {
    const remoteProfile = remote.profiles[profile] || {};
    const localProfile = local.profiles[profile] || {};
    merged.profiles[profile] = {
      history: mergeHistory(remoteProfile.history, localProfile.history),
      notes: { ...(remoteProfile.notes || {}), ...(localProfile.notes || {}) },
      dirToggle: { ...(remoteProfile.dirToggle || {}), ...(localProfile.dirToggle || {}) },
      answerMode: localProfile.answerMode || remoteProfile.answerMode || 'write'
    };
  });
  merged.shared = {
    editableData: mergeEditableData(remote.shared.editableData, local.shared.editableData),
    monumentos: mergeItemArrays(remote.shared.monumentos, local.shared.monumentos),
    pins: { ...(remote.shared.pins || {}), ...(local.shared.pins || {}) }
  };
  return merged;
}

function writeJsonIfPresent(key, value){
  if(value == null) return false;
  const next = JSON.stringify(value);
  if(localStorage.getItem(key) === next) return false;
  localStorage.setItem(key, next);
  return true;
}

function applySnapshot(value){
  const snapshot = normalizeSnapshot(value);
  let changed = false;
  PROFILE_NAMES.forEach(profile => {
    const data = snapshot.profiles[profile] || {};
    changed = writeJsonIfPresent(`speis_${profile}_history_v2`, data.history) || changed;
    changed = writeJsonIfPresent(`speis_${profile}_notes`, data.notes) || changed;
    changed = writeJsonIfPresent(`speis_${profile}_dirtoggle`, data.dirToggle) || changed;
    if(data.answerMode && localStorage.getItem(`speis_${profile}_monument_answer_mode`) !== data.answerMode){
      localStorage.setItem(`speis_${profile}_monument_answer_mode`, data.answerMode);
      changed = true;
    }
  });
  changed = writeJsonIfPresent('speis_quiz_editable_data_v1', snapshot.shared.editableData) || changed;
  changed = writeJsonIfPresent('speis_monumentos_custom_v1', snapshot.shared.monumentos) || changed;
  changed = writeJsonIfPresent('speis_quiz_map_pins_v1', snapshot.shared.pins) || changed;
  return changed;
}

function setStatus(kind, text){
  ['profile-sync-button', 'header-sync-button'].forEach(id => {
    const button = document.getElementById(id);
    if(!button) return;
    button.textContent = text;
    button.className = `sync-status-btn${kind ? ` ${kind}` : ''}`;
  });
}

function showMessage(text, kind = ''){
  const element = document.getElementById('sync-message');
  if(!element) return;
  element.textContent = text;
  element.className = `sync-message${kind ? ` ${kind}` : ''}`;
}

function refreshAuthUI(){
  const signedIn = !!currentSession?.user;
  document.getElementById('sync-signed-out').hidden = signedIn;
  document.getElementById('sync-signed-in').hidden = !signedIn;
  document.getElementById('sync-user-email').textContent = signedIn ? currentSession.user.email || 'Cuenta conectada' : '';
  if(!signedIn) setStatus('', '☁ Sin conectar');
}

function authValues(){
  return {
    email: document.getElementById('sync-email').value.trim(),
    password: document.getElementById('sync-password').value
  };
}

function authValuesAreValid(values){
  if(!values.email || !values.email.includes('@')){
    showMessage('Escribe un correo válido.', 'error');
    return false;
  }
  if(values.password.length < 6){
    showMessage('La contraseña debe tener al menos 6 caracteres.', 'error');
    return false;
  }
  return true;
}

async function fetchCloudRow(){
  return supabase.from(SYNC_TABLE).select('payload,updated_at').maybeSingle();
}

async function upsertSnapshot(snapshot){
  const result = await supabase.from(SYNC_TABLE)
    .upsert({ user_id: currentSession.user.id, payload: snapshot }, { onConflict: 'user_id' })
    .select('updated_at')
    .single();
  if(result.error) throw result.error;
  lastCloudUpdatedAt = result.data?.updated_at || lastCloudUpdatedAt;
  localStorage.setItem(SYNC_USER_KEY, currentSession.user.id);
  localStorage.removeItem(SYNC_DIRTY_KEY);
}

async function initialSync(){
  if(!currentSession?.user) return;
  cloudReady = false;
  setStatus('', '☁ Sincronizando…');
  showMessage('Comprobando los datos guardados…');
  try{
    const local = captureLocalSnapshot();
    const response = await fetchCloudRow();
    if(response.error) throw response.error;
    const row = response.data;
    const sameUser = localStorage.getItem(SYNC_USER_KEY) === currentSession.user.id;
    const localDirty = localStorage.getItem(SYNC_DIRTY_KEY) === '1';
    let chosen = local;
    let mustUpload = !row;
    if(row){
      lastCloudUpdatedAt = row.updated_at || '';
      const remote = normalizeSnapshot(row.payload);
      if((!sameUser || localDirty) && hasMeaningfulData(local)){
        chosen = mergeSnapshots(remote, local);
        mustUpload = JSON.stringify(chosen) !== JSON.stringify(remote);
      }else chosen = remote;
    }
    const changed = applySnapshot(chosen);
    if(mustUpload) await upsertSnapshot(chosen);
    else{
      localStorage.setItem(SYNC_USER_KEY, currentSession.user.id);
      localStorage.removeItem(SYNC_DIRTY_KEY);
    }
    cloudReady = true;
    setStatus('online', '☁ Sincronizado');
    showMessage('Datos sincronizados correctamente.', 'ok');
    if(changed) window.setTimeout(() => window.location.reload(), 250);
  }catch(error){
    cloudReady = false;
    setStatus('error', '☁ Error de sincronización');
    const missingTable = String(error?.message || '').includes(SYNC_TABLE) || error?.code === '42P01';
    showMessage(missingTable ? 'Falta preparar la tabla de sincronización en Supabase.' : `No se pudo sincronizar: ${error?.message || 'error desconocido'}`, 'error');
  }
}

async function pushCloudState(){
  if(!cloudReady || !currentSession?.user) return;
  if(pushInFlight){ pushAgain = true; return; }
  pushInFlight = true;
  setStatus('', '☁ Sincronizando…');
  try{
    let local = captureLocalSnapshot();
    const response = await fetchCloudRow();
    if(response.error) throw response.error;
    if(response.data && response.data.updated_at && response.data.updated_at !== lastCloudUpdatedAt){
      local = mergeSnapshots(response.data.payload, local);
      applySnapshot(local);
    }
    await upsertSnapshot(local);
    setStatus('online', '☁ Sincronizado');
    showMessage('Últimos cambios guardados.', 'ok');
  }catch(error){
    localStorage.setItem(SYNC_DIRTY_KEY, '1');
    setStatus('error', '☁ Pendiente de sincronizar');
    showMessage(`Los cambios siguen guardados en este dispositivo. ${error?.message || ''}`.trim(), 'error');
  }finally{
    pushInFlight = false;
    if(pushAgain){ pushAgain = false; pushCloudState(); }
  }
}

function scheduleCloudPush(){
  localStorage.setItem(SYNC_DIRTY_KEY, '1');
  window.clearTimeout(pushTimer);
  if(!cloudReady) return;
  pushTimer = window.setTimeout(pushCloudState, 700);
}

function wrapSaveFunction(name){
  const original = window[name];
  if(typeof original !== 'function' || original.__cloudWrapped) return;
  const wrapped = function(...args){
    const result = original.apply(this, args);
    scheduleCloudPush();
    return result;
  };
  wrapped.__cloudWrapped = true;
  window[name] = wrapped;
}

['saveHistory', 'saveNotes', 'saveDirToggle', 'saveEditableData', 'saveMonumentosData', 'savePinStore', 'setMonumentAnswerMode']
  .forEach(wrapSaveFunction);

window.openSyncModal = function(){
  document.getElementById('sync-modal').classList.add('open');
  refreshAuthUI();
  showMessage(currentSession?.user ? 'La sincronización está activa.' : 'Usa la misma cuenta en todos tus dispositivos.');
};

window.closeSyncModal = function(){ document.getElementById('sync-modal').classList.remove('open'); };

window.syncSignIn = async function(){
  const values = authValues();
  if(!authValuesAreValid(values)) return;
  showMessage('Entrando…');
  const { data, error } = await supabase.auth.signInWithPassword(values);
  if(error){ showMessage(`No se pudo entrar: ${error.message}`, 'error'); return; }
  currentSession = data.session;
  handledUserId = currentSession?.user?.id || null;
  refreshAuthUI();
  await initialSync();
};

window.syncSignUp = async function(){
  const values = authValues();
  if(!authValuesAreValid(values)) return;
  showMessage('Creando el acceso…');
  const { data, error } = await supabase.auth.signUp({
    ...values,
    options: { emailRedirectTo: `${window.location.origin}${window.location.pathname}` }
  });
  if(error){ showMessage(`No se pudo crear: ${error.message}`, 'error'); return; }
  if(data.session){
    currentSession = data.session;
    handledUserId = currentSession.user.id;
    refreshAuthUI();
    await initialSync();
  }else showMessage('Revisa tu correo y confirma el acceso. Después podrás entrar.', 'ok');
};

window.syncSignOut = async function(){
  if(cloudReady) await pushCloudState();
  const { error } = await supabase.auth.signOut();
  if(error){ showMessage(`No se pudo cerrar la sesión: ${error.message}`, 'error'); return; }
  currentSession = null;
  cloudReady = false;
  handledUserId = null;
  refreshAuthUI();
  showMessage('Sesión cerrada. Los datos locales se conservan.', 'ok');
};

window.syncNow = async function(){
  if(!currentSession?.user){ showMessage('Primero debes entrar.', 'error'); return; }
  if(!cloudReady){ await initialSync(); return; }
  localStorage.setItem(SYNC_DIRTY_KEY, '1');
  window.clearTimeout(pushTimer);
  await pushCloudState();
};

document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'hidden') pushCloudState();
  else if(document.visibilityState === 'visible' && currentSession?.user && !pushInFlight) initialSync();
});
window.addEventListener('online', () => { if(currentSession?.user) initialSync(); });

async function initializeCloudSync(){
  setStatus('', '☁ Preparando…');
  const { data, error } = await supabase.auth.getSession();
  if(error){
    setStatus('error', '☁ Error de conexión');
    showMessage(error.message, 'error');
    return;
  }
  currentSession = data.session;
  refreshAuthUI();
  if(currentSession?.user){
    handledUserId = currentSession.user.id;
    await initialSync();
  }
}

initializeCloudSync();
