// ─── Data Layer ───────────────────────────────────────────────
const STORAGE_KEY = 'kidcash_data';

function getDefaultData() {
  return {
    kids: [
      { id: generateId(), name: 'Kid 1' },
      { id: generateId(), name: 'Kid 2' },
    ],
    transactions: [],
    goals: [],
    chores: [],
    choreTemplates: null, // null = use defaults
    recurringActivities: [],
    activeKidIndex: 0,
    wishlistShares: {}, // { [kidId]: shareToken }
    choreShares: {}, // { [kidId]: shareToken }
    familyId: null,
  };
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (!data.goals) data.goals = [];
      if (!data.wishlist) data.wishlist = [];
      if (!data.wishlistShares) data.wishlistShares = {};
      if (!data.choreShares) data.choreShares = {};
      if (!data.chores) data.chores = [];
      if (!data.recurringActivities) data.recurringActivities = [];
      if (data.familyId === undefined) data.familyId = null;
      // choreTemplates intentionally left as undefined/null — getChoreTemplates() handles defaults
      return data;
    }
  } catch (e) {
    console.error('Failed to load data', e);
  }
  return getDefaultData();
}

const BACKUP_KEY = 'kidcash_backup';

function saveData(data) {
  // Safety: never overwrite existing transactions with an empty array
  try {
    const existing = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if ((existing.transactions?.length || 0) > 0 && (data.transactions?.length || 0) === 0) {
      console.error('saveData safety check: refusing to overwrite transactions with empty array');
      return;
    }
  } catch (e) { /* ignore parse errors */ }
  data.updatedAt = Date.now();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  scheduleSyncToFirestore();
}

// ─── Sync Engine ─────────────────────────────────────────────
// Debounced (1.5s), serialized (one write at a time), auto-retry on failure
let syncStatus = 'ok'; // 'ok' | 'error'
let _syncTimer = null;
let _syncInProgress = false;
let _syncQueued = false;

// Direct write — used by loadFromFirestore for initial sync
async function writeToFirestore(uid, data) {
  const docRef = fbDoc(firebaseDb, 'users', uid);
  const payload = {
    kids: data.kids || [],
    transactions: data.transactions || [],
    goals: data.goals || [],
    wishlist: data.wishlist || [],
    chores: data.chores || [],
    choreTemplates: data.choreTemplates || null,
    recurringActivities: data.recurringActivities || [],
    activeKidIndex: data.activeKidIndex || 0,
    updatedAt: data.updatedAt || Date.now(),
    wishlistShares: data.wishlistShares || {},
    choreShares: data.choreShares || {},
  };
  if (data.parentPin) payload.parentPin = data.parentPin;
  if (data.paypalMe)    payload.paypalMe    = data.paypalMe;
  if (data.venmoHandle) payload.venmoHandle = data.venmoHandle;
  if (data.appleCash)   payload.appleCash   = data.appleCash;
  if (data.familyId) payload.familyId = data.familyId;
  if (data.role)     payload.role     = data.role;
  await fbSetDoc(docRef, payload);
}

async function syncPublicWishlist(kidId, token) {
  if (!window.fbSetDoc || !window.firebaseDb || !currentUser) return;
  const kid = state.kids.find(k => k.id === kidId);
  if (!kid) return;
  const wishlist = getKidWishlist(kidId);
  const docRef = fbDoc(firebaseDb, 'public_wishlists', token);
  await fbSetDoc(docRef, {
    kidName: kid.name,
    items: wishlist.map(w => ({
      id: w.id,
      name: w.name,
      price: w.price,
      url: w.url || '',
      image: w.image || null,
    })),
    updatedAt: Date.now(),
    uid: currentUser.uid,
    ...(state.paypalMe    ? { paypalMe:    state.paypalMe }    : {}),
    ...(state.venmoHandle ? { venmoHandle: state.venmoHandle } : {}),
    ...(state.appleCash   ? { appleCash:   state.appleCash }   : {}),
  });
}

async function syncAllPublicWishlists() {
  const shares = state.wishlistShares || {};
  for (const [kidId, token] of Object.entries(shares)) {
    try { await syncPublicWishlist(kidId, token); } catch (e) { /* best-effort */ }
  }
}

async function syncPublicChoreBoard(kidId, token) {
  if (!window.fbSetDoc || !window.firebaseDb || !currentUser) return;
  const kid = state.kids.find(k => k.id === kidId);
  if (!kid) return;
  const docRef = fbDoc(firebaseDb, 'public_chore_boards', token);
  await fbSetDoc(docRef, {
    kidName: kid.name,
    kidId: kid.id,
    updatedAt: Date.now(),
    uid: currentUser.uid,
  });
}

async function syncAllPublicChoreBoards() {
  const shares = state.choreShares || {};
  for (const [kidId, token] of Object.entries(shares)) {
    try { await syncPublicChoreBoard(kidId, token); } catch (e) { /* best-effort */ }
  }
}

// Schedule a debounced sync (waits 1.5s after last change)
function scheduleSyncToFirestore() {
  if (!currentUser || !window.fbSetDoc) return;
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(flushToFirestore, 1500);
}

// Flush in-memory state to Firestore
async function flushToFirestore() {
  if (contributorRole === 'contributor') return; // contributors never write parent data
  if (!currentUser || !window.fbSetDoc) return;
  clearTimeout(_syncTimer);

  // If a write is already in progress, queue another one for when it finishes
  if (_syncInProgress) {
    _syncQueued = true;
    return;
  }

  // Safety: don't sync if in-memory state has no transactions but localStorage does
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if ((stored.transactions?.length || 0) > 0 && (state.transactions?.length || 0) === 0) {
      console.error('flushToFirestore safety check: in-memory state looks empty, aborting sync');
      return;
    }
  } catch (e) { /* ignore */ }

  _syncInProgress = true;
  try {
    await writeToFirestore(currentUser.uid, state); // use in-memory state, not re-read from localStorage
    await syncAllPublicWishlists();
    await syncAllPublicChoreBoards();
    if (syncStatus !== 'ok') {
      syncStatus = 'ok';
      render();
    }
  } catch (e) {
    console.error('Firestore sync failed:', e);
    if (syncStatus !== 'error') {
      syncStatus = 'error';
      render();
    }
    // Auto-retry in 10 seconds
    _syncTimer = setTimeout(flushToFirestore, 10000);
  } finally {
    _syncInProgress = false;
    if (_syncQueued) {
      _syncQueued = false;
      // Process the queued write after a short delay
      setTimeout(flushToFirestore, 500);
    }
  }
}

// Sync when app comes back to foreground (catches missed saves)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentUser && window.fbSetDoc) {
    flushToFirestore();
  }
});

// Best-effort flush before page closes (data is safe in localStorage regardless)
window.addEventListener('pagehide', () => {
  if (currentUser && _syncTimer) {
    clearTimeout(_syncTimer);
    flushToFirestore();
  }
});

async function loadFromFirestore(uid) {
  try {
    const docRef = fbDoc(firebaseDb, 'users', uid);
    const docSnap = await fbGetDoc(docRef);
    const localData = loadData();
    const localTime = localData.updatedAt || 0;

    if (docSnap.exists()) {
      const cloudData = docSnap.data();
      const cloudTime = cloudData.updatedAt || 0;
      if (!cloudData.goals) cloudData.goals = [];
      if (!cloudData.wishlist) cloudData.wishlist = [];
      if (!cloudData.wishlistShares) cloudData.wishlistShares = {};
      if (!cloudData.choreShares) cloudData.choreShares = {};
      if (!cloudData.chores) cloudData.chores = [];
      if (!cloudData.recurringActivities) cloudData.recurringActivities = [];

      const localTxCount = localData.transactions?.length || 0;
      const cloudTxCount = cloudData.transactions?.length || 0;
      // Prefer whichever has more transactions; break ties with timestamp
      const useLocal = localTxCount > cloudTxCount ||
        (localTxCount === cloudTxCount && localTime > cloudTime && localTxCount > 0);
      if (useLocal) {
        console.log(`Local data wins (${localTxCount} tx local vs ${cloudTxCount} tx cloud), syncing to cloud`);
        state = localData;
        await writeToFirestore(uid, state);
      } else {
        // Cloud data is richer or same — use it
        state = cloudData;
      }
    } else if (localData.transactions?.length > 0) {
      // No cloud data but local data exists — push it up
      console.log('No cloud data found, pushing local data');
      state = localData;
      await writeToFirestore(uid, state);
    } else {
      // New user, no data anywhere — initialize with defaults
      state = getDefaultData();
      state.wishlist = [];
      state.updatedAt = Date.now();
      await writeToFirestore(uid, state);
    }
    // Cache locally and save a backup of this known-good Firestore state
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    localStorage.setItem(BACKUP_KEY, JSON.stringify(state));

    // Detect contributor role
    if (state.role === 'contributor' && state.familyId) {
      contributorRole = 'contributor';
      contributorFamilyId = state.familyId;
      try { await loadContributorData(); } catch(e) { console.error('contributor load failed', e); }
    } else if (state.familyId) {
      ownerFamilyId = state.familyId;
      try { await loadOwnerFamilyMembers(); } catch(e) { /* best-effort */ }
    }
  } catch (e) {
    console.error('Firestore load failed, using local data:', e);
    state = loadData();
  }
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ─── Recurring Activities ────────────────────────────────────
function getNextDueDate(fromTimestamp, frequency) {
  const d = new Date(fromTimestamp);
  if (frequency === 'weekly') d.setDate(d.getDate() + 7);
  else if (frequency === 'biweekly') d.setDate(d.getDate() + 14);
  else if (frequency === 'monthly') d.setMonth(d.getMonth() + 1);
  return d.getTime();
}

function processRecurringActivities() {
  if (!state.recurringActivities || !state.recurringActivities.length) return;
  const now = Date.now();
  let changed = false;
  state.recurringActivities.forEach(r => {
    if (!r.active) return;
    while (r.nextDue <= now) {
      state.transactions.push({
        id: generateId(),
        kidId: r.kidId,
        type: r.type,
        amount: r.amount,
        description: r.description,
        category: r.category,
        timestamp: r.nextDue,
        createdBy: 'parent',
        recurringId: r.id,
      });
      r.nextDue = getNextDueDate(r.nextDue, r.frequency);
      changed = true;
    }
  });
  if (changed) saveData(state);
}

// ─── State ────────────────────────────────────────────────────
let state = loadData();
let currentView = 'home'; // 'home' | 'activity' | 'goals' | 'settings'
let modalOpen = null; // null | 'transaction' | 'wishlist' | 'wishlist-share' | 'recurring'
let txType = 'income';
let recurringType = 'income';
let activityTab = 'history'; // 'history' | 'recurring'
let editingRecurringId = null;
let choreRepeating = false;
let chorePrefill = { name: '', amount: '' };
let editingChoreId = null;
let editingTemplateId = null;
let confirmAction = null;
let pendingWishlistPurchase = null;
let shareModalKidId = null;
let wishlistShareClaims = null; // null=not loaded, {}=loading/empty, {itemId:{claimedBy}}=loaded
let wishlistClaimsCache = {}; // { [kidId]: { [itemId]: claimData } | null } null=loading
let pendingChoresCache = {}; // { [kidId]: null | { [choreId]: choreData } }
let fetchStatus = null;
let contributorRole = null;       // null | 'contributor'
let contributorFamilyId = null;
let contributorFamilyData = null; // { ownerId, name, ... }
let contributorKids = [];
let contributorWishlists = {};    // { [kidId]: { items, claims } }
let contributorChores = {};       // { [kidId]: { token, pending: [{id,...}] } }
let ownerFamilyId = null;         // set if this user owns a family
let ownerFamilyMembers = [];      // [{ uid, displayName, email, joinedAt }]
let fetchedProduct = { name: '', price: '', image: null };

// ─── Auth State ──────────────────────────────────────────────
let currentUser = null;
let appReady = false;
let authMode = 'login'; // 'login' | 'signup' | 'reset'
let authError = '';
let authMessage = '';
let authBusy = false;

// ─── Kid Mode State ─────────────────────────────────────────
let kidModeEnabled = localStorage.getItem('kidcash_kidmode') === 'true';
let kidModeLocked = kidModeEnabled; // start locked if enabled
let kidModeKidIndex = null;         // which kid is authenticated
let kidModePinEntry = '';           // PIN being typed
let kidModePinError = '';           // error on PIN screen
let kidModeSelectedKid = null;      // kid tapped on selection screen
let showParentUnlockModal = false;
let parentUnlockError = '';
let parentUnlockBusy = false;

function isInKidMode() {
  return kidModeEnabled && !kidModeLocked && kidModeKidIndex !== null;
}

function getActiveKid() {
  if (isInKidMode()) {
    return state.kids[kidModeKidIndex] || state.kids[0];
  }
  return state.kids[state.activeKidIndex] || state.kids[0];
}

function getKidTransactions(kidId) {
  return state.transactions
    .filter(t => t.kidId === kidId)
    .sort((a, b) => b.timestamp - a.timestamp);
}

function getKidGoals(kidId) {
  return state.goals.filter(g => g.kidId === kidId);
}

function getKidWishlist(kidId) {
  return state.wishlist
    .filter(w => w.kidId === kidId)
    .sort((a, b) => b.addedAt - a.addedAt);
}

function getKidChores(kidId) {
  return (state.chores || []).filter(c => c.kidId === kidId);
}

function getBalance(kidId) {
  return state.transactions
    .filter(t => t.kidId === kidId)
    .reduce((sum, t) => sum + (t.type === 'income' ? t.amount : -t.amount), 0);
}

function getTotalIncome(kidId) {
  return state.transactions
    .filter(t => t.kidId === kidId && t.type === 'income')
    .reduce((sum, t) => sum + t.amount, 0);
}

function getTotalExpenses(kidId) {
  return state.transactions
    .filter(t => t.kidId === kidId && t.type === 'expense')
    .reduce((sum, t) => sum + t.amount, 0);
}

// ─── PIN Security ─────────────────────────────────────────────
async function hashPin(pin, salt) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(`kidcash:${salt}:${pin}`));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function isPinHash(str) {
  return typeof str === 'string' && str.length === 64 && /^[0-9a-f]+$/.test(str);
}

function getPinLockout(key) {
  try { return JSON.parse(localStorage.getItem(`kidcash_pin_lock_${key}`)) || { fails: 0, lockedUntil: 0 }; }
  catch { return { fails: 0, lockedUntil: 0 }; }
}

function recordPinFail(key) {
  const lock = getPinLockout(key);
  lock.fails = (lock.fails || 0) + 1;
  if (lock.fails >= 5) lock.lockedUntil = Date.now() + 5 * 60 * 1000;
  localStorage.setItem(`kidcash_pin_lock_${key}`, JSON.stringify(lock));
  return lock;
}

function clearPinFail(key) {
  localStorage.removeItem(`kidcash_pin_lock_${key}`);
}

function isPinLocked(key) {
  return getPinLockout(key).lockedUntil > Date.now();
}

function pinLockMinutes(key) {
  return Math.max(1, Math.ceil((getPinLockout(key).lockedUntil - Date.now()) / 60000));
}

// ─── Formatting ───────────────────────────────────────────────
function formatMoney(cents) {
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remaining = abs % 100;
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${dollars.toLocaleString()}.${remaining.toString().padStart(2, '0')}`;
}

function parseMoney(str) {
  const num = parseFloat(str);
  if (isNaN(num) || num <= 0) return 0;
  return Math.round(num * 100);
}

function formatDate(timestamp) {
  const d = new Date(timestamp);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) {
    const days = Math.floor(diff / 86400000);
    return days === 1 ? 'Yesterday' : `${days}d ago`;
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ─── Sales Tax by State ──────────────────────────────────────
const STATE_TAX_RATES = {
  '': { name: 'No Tax', rate: 0 },
  'AL': { name: 'Alabama', rate: 4.00 },
  'AK': { name: 'Alaska', rate: 0 },
  'AZ': { name: 'Arizona', rate: 5.60 },
  'AR': { name: 'Arkansas', rate: 6.50 },
  'CA': { name: 'California', rate: 7.25 },
  'CO': { name: 'Colorado', rate: 2.90 },
  'CT': { name: 'Connecticut', rate: 6.35 },
  'DE': { name: 'Delaware', rate: 0 },
  'FL': { name: 'Florida', rate: 6.00 },
  'GA': { name: 'Georgia', rate: 4.00 },
  'HI': { name: 'Hawaii', rate: 4.00 },
  'ID': { name: 'Idaho', rate: 6.00 },
  'IL': { name: 'Illinois', rate: 6.25 },
  'IN': { name: 'Indiana', rate: 7.00 },
  'IA': { name: 'Iowa', rate: 6.00 },
  'KS': { name: 'Kansas', rate: 6.50 },
  'KY': { name: 'Kentucky', rate: 6.00 },
  'LA': { name: 'Louisiana', rate: 4.45 },
  'ME': { name: 'Maine', rate: 5.50 },
  'MD': { name: 'Maryland', rate: 6.00 },
  'MA': { name: 'Massachusetts', rate: 6.25 },
  'MI': { name: 'Michigan', rate: 6.00 },
  'MN': { name: 'Minnesota', rate: 6.875 },
  'MS': { name: 'Mississippi', rate: 7.00 },
  'MO': { name: 'Missouri', rate: 4.225 },
  'MT': { name: 'Montana', rate: 0 },
  'NE': { name: 'Nebraska', rate: 5.50 },
  'NV': { name: 'Nevada', rate: 6.85 },
  'NH': { name: 'New Hampshire', rate: 0 },
  'NJ': { name: 'New Jersey', rate: 6.625 },
  'NM': { name: 'New Mexico', rate: 4.875 },
  'NY': { name: 'New York', rate: 4.00 },
  'NC': { name: 'North Carolina', rate: 4.75 },
  'ND': { name: 'North Dakota', rate: 5.00 },
  'OH': { name: 'Ohio', rate: 5.75 },
  'OK': { name: 'Oklahoma', rate: 4.50 },
  'OR': { name: 'Oregon', rate: 0 },
  'PA': { name: 'Pennsylvania', rate: 6.00 },
  'RI': { name: 'Rhode Island', rate: 7.00 },
  'SC': { name: 'South Carolina', rate: 6.00 },
  'SD': { name: 'South Dakota', rate: 4.20 },
  'TN': { name: 'Tennessee', rate: 7.00 },
  'TX': { name: 'Texas', rate: 6.25 },
  'UT': { name: 'Utah', rate: 6.10 },
  'VT': { name: 'Vermont', rate: 6.00 },
  'VA': { name: 'Virginia', rate: 5.30 },
  'WA': { name: 'Washington', rate: 6.50 },
  'WV': { name: 'West Virginia', rate: 6.00 },
  'WI': { name: 'Wisconsin', rate: 5.00 },
  'WY': { name: 'Wyoming', rate: 4.00 },
  'DC': { name: 'Washington DC', rate: 6.00 },
};

let selectedState = localStorage.getItem('kidcash_state') || '';

function calcTax(amountCents, stateCode) {
  const info = STATE_TAX_RATES[stateCode];
  if (!info || info.rate === 0) return 0;
  return Math.round(amountCents * info.rate / 100);
}

// ─── Product Fetch ───────────────────────────────────────────
const RETAILER_RULES = [
  { match: /amazon\.|amzn\.|a\.co/i, priceSelector: '#corePrice_feature_div .a-offscreen, span.a-price[data-a-size] .a-offscreen, .a-price .a-offscreen, #priceblock_ourprice', imageSelector: '#landingImage, #imgBlkFront, img.a-dynamic-image, #main-image-container img' },
  { match: /walmart\./i, priceSelector: '[itemprop="price"], [data-automation="buybox-price"], span[class*="price-characteristic"]', imageSelector: '[data-testid="hero-image"] img' },
  { match: /target\./i, priceSelector: '[data-test="product-price"], span[class*="CurrentPrice"]', imageSelector: '[data-test="product-image"] img' },
  { match: /bestbuy\./i, priceSelector: '.priceView-customer-price span, [data-testid="customer-price"]', imageSelector: '.primary-image' },
  { match: /ebay\./i, priceSelector: '.x-price-primary span, #prcIsum', imageSelector: '#icImg, .ux-image-carousel img' },
  { match: /etsy\./i, priceSelector: '[data-buy-box-listing-price], .wt-text-title-03', imageSelector: '[data-listing-card-image] img' },
];

async function fetchProductInfo(url) {
  const microlinkResult = await fetchViaMicrolink(url);
  if (microlinkResult && (microlinkResult.name || microlinkResult.price)) {
    return microlinkResult;
  }
  const proxyResult = await fetchViaProxy(url);
  if (proxyResult && (proxyResult.name || proxyResult.price)) {
    return proxyResult;
  }
  return null;
}

// Build a Microlink API URL with optional retailer-specific data extraction
function buildMicrolinkUrl(url) {
  let apiUrl = `https://api.microlink.io/?url=${encodeURIComponent(url)}`;
  const rule = RETAILER_RULES.find(r => r.match.test(url));
  if (rule) {
    apiUrl += `&data.price.selector=${encodeURIComponent(rule.priceSelector)}&data.price.type=text`;
    if (rule.imageSelector) {
      apiUrl += `&data.productImage.selector=${encodeURIComponent(rule.imageSelector)}&data.productImage.type=image&data.productImage.attr=src`;
    }
  }
  return { apiUrl, rule };
}

// Parse a Microlink response into our result format
function parseMicrolinkResult(d, rule) {
  const result = { name: '', price: '', image: null };
  result.name = d.title || '';
  result.name = result.name
    .replace(/^Amazon\.com:\s*/i, '')
    .replace(/\s*[-|:]\s*(Amazon|Walmart|Target|Best Buy|eBay|Etsy).*$/i, '')
    .replace(/\s*[-|:]\s*[A-Z][a-z]+\.(com|ca|co\.uk).*$/i, '')
    .trim()
    .slice(0, 200); // clamp to prevent absurdly long titles from third-party APIs

  // Filter out generic site logos, marketing images, and favicons
  const isGenericImage = (url) => /\/marketing\/|\/prime|\/sprite|\/logo|\/brand|\/badge|Logos\/|favicon/i.test(url || '');

  // Prefer retailer-specific product image over generic og:image
  if (d.productImage?.url && !isGenericImage(d.productImage.url)) {
    result.image = d.productImage.url;
  } else if (d.image?.url && !isGenericImage(d.image.url)) {
    result.image = d.image.url;
  }
  // Don't fall back to logo — it's usually a favicon or site icon, not useful
  // Validate image URL is https (no data: or javascript: sources from third-party APIs)
  if (result.image && !/^https:\/\//i.test(result.image)) result.image = null;

  // Extract price from custom selector
  if (d.price && !/^\s*-?\d+%/.test(d.price)) {
    // Skip percentage-only values like "-10%" (discount badges)
    const priceMatch = d.price.match(/\$?([\d,]+\.?\d{0,2})/);
    if (priceMatch) {
      const val = parseFloat(priceMatch[1].replace(',', ''));
      if (val > 0.5 && val < 100000) result.price = val.toFixed(2);
    }
  }
  // Fallback: look for price in description
  if (!result.price && d.description) {
    const priceMatch = d.description.match(/\$(\d[\d,]*\.?\d{0,2})/);
    if (priceMatch) {
      const val = parseFloat(priceMatch[1].replace(',', ''));
      if (val > 0 && val < 100000) result.price = val.toFixed(2);
    }
  }
  return result;
}

async function fetchViaMicrolink(url) {
  try {
    // First request
    const { apiUrl, rule } = buildMicrolinkUrl(url);
    const resp = await fetch(apiUrl, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error('Microlink failed');
    const json = await resp.json();
    if (json.status !== 'success' || !json.data) throw new Error('Bad response');
    const d = json.data;

    // Check if the resolved URL is different (shortened URL was expanded)
    const resolvedUrl = d.url || url;
    const resolvedRule = RETAILER_RULES.find(r => r.match.test(resolvedUrl));

    // If the original URL didn't match a retailer but the resolved one does,
    // retry with retailer-specific selectors for better price/image extraction
    if (!rule && resolvedRule && resolvedUrl !== url) {
      console.log('Short URL resolved to retailer, retrying with selectors:', resolvedUrl);
      const { apiUrl: retryUrl } = buildMicrolinkUrl(resolvedUrl);
      const resp2 = await fetch(retryUrl, { signal: AbortSignal.timeout(15000) });
      if (resp2.ok) {
        const json2 = await resp2.json();
        if (json2.status === 'success' && json2.data) {
          return parseMicrolinkResult(json2.data, resolvedRule);
        }
      }
    }

    return parseMicrolinkResult(d, rule || resolvedRule);
  } catch (e) {
    console.warn('Microlink fetch failed:', e);
    return null;
  }
}

async function fetchViaProxy(url) {
  try {
    const proxyUrl = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url);
    const resp = await fetch(proxyUrl, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error('Proxy fetch failed');
    const html = await resp.text();
    return parseProductFromHtml(html, url);
  } catch (e) {
    console.warn('Proxy fetch failed:', e);
    return null;
  }
}

function parseProductFromHtml(html, url) {
  const result = { name: '', price: '', image: null };
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const ldScripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const script of ldScripts) {
    try {
      let data = JSON.parse(script.textContent);
      if (Array.isArray(data)) data = data[0];
      if (data['@graph']) {
        data = data['@graph'].find(item =>
          item['@type'] === 'Product' || item['@type']?.includes?.('Product')
        ) || data;
      }
      if (data['@type'] === 'Product' || data['@type']?.includes?.('Product')) {
        result.name = data.name || result.name;
        if (data.image) {
          result.image = Array.isArray(data.image) ? data.image[0] : (typeof data.image === 'string' ? data.image : data.image.url);
        }
        const offers = data.offers;
        if (offers) {
          const offer = Array.isArray(offers) ? offers[0] : offers;
          const price = offer.price || offer.lowPrice;
          if (price) result.price = parseFloat(price).toFixed(2);
        }
      }
    } catch (e) { /* skip bad JSON-LD */ }
  }
  if (!result.name) {
    const ogTitle = doc.querySelector('meta[property="og:title"]');
    result.name = ogTitle?.content || '';
  }
  if (!result.image) {
    const ogImage = doc.querySelector('meta[property="og:image"]');
    result.image = ogImage?.content || null;
  }
  if (!result.price) {
    const priceTag = doc.querySelector('meta[property="product:price:amount"], meta[property="og:price:amount"]');
    if (priceTag?.content) result.price = parseFloat(priceTag.content).toFixed(2);
  }
  if (!result.name) {
    const title = doc.querySelector('title');
    result.name = title?.textContent?.trim()?.split('|')[0]?.split('-')[0]?.trim() || '';
  }
  if (!result.price) {
    const rule = RETAILER_RULES.find(r => r.match.test(url));
    const selectors = rule ? rule.priceSelector.split(',').map(s => s.trim()) : [];
    selectors.push('[data-price]', '.price', '.product-price', '#price',
      '[class*="price"]', '[class*="Price"]', 'span[class*="amount"]');
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      if (el) {
        const text = el.getAttribute('data-price') || el.getAttribute('content') || el.textContent;
        const match = text.match(/\$?([\d,]+\.?\d{0,2})/);
        if (match) {
          const val = parseFloat(match[1].replace(',', ''));
          if (val > 0 && val < 100000) {
            result.price = val.toFixed(2);
            break;
          }
        }
      }
    }
  }
  if (result.image && !result.image.startsWith('http')) {
    try {
      const base = new URL(url);
      result.image = new URL(result.image, base.origin).href;
    } catch (e) { result.image = null; }
  }
  if (result.name) {
    result.name = result.name
      .replace(/\s*[-|:]\s*(Amazon|Walmart|Target|Best Buy|eBay|Etsy).*$/i, '')
      .trim();
  }
  return result;
}

// ─── SVG Icon Helper ──────────────────────────────────────────
function svgIcon(paths, size = 20) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}
const SVG = {
  inbox:    `<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>`,
  target:   `<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>`,
  star:     `<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>`,
  repeat:   `<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>`,
  checkSq:  `<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>`,
  broom:    `<path d="M9 6 6.5 3.5a1.5 1.5 0 0 0-1-.5C4 3 4 3.5 4 4v4.5l2.5 2.5"/><path d="m12 15 4.5 4.5"/><path d="M15 12l4.5-4.5"/><path d="m6.5 8.5 5 5"/><path d="m9 6 2 2"/><path d="M10.5 7.5 15 3"/><path d="M17 10l-1.5 1.5"/><path d="m11 17 2-2"/><path d="M9.9 9.9 3 17l-.5 3.5 3.5-.5L13 13"/>`,
  dollar:   `<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>`,
  cart:     `<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>`,
  arrowUp:  `<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>`,
  arrowDn:  `<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>`,
  warning:  `<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>`,
};

// ─── Kid Avatars ──────────────────────────────────────────────
function kidAvatarColor(name) {
  const palette = ['#6C5CE7','#00A878','#0984E3','#E17055','#8E44AD','#00838F','#D35400','#1E8449'];
  let h = 0;
  for (const c of (name || '')) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return palette[h % palette.length];
}

function kidAvatarHtml(name, size = 36) {
  const color = kidAvatarColor(name);
  const initials = name.trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const fontSize = Math.round(size * 0.38);
  return `<div class="kid-avatar-circle" style="width:${size}px;height:${size}px;background:${color};font-size:${fontSize}px">${initials}</div>`;
}

function progressRing(percent, size = 52) {
  const r = (size - 7) / 2;
  const circ = +(2 * Math.PI * r).toFixed(2);
  const offset = +(circ * (1 - Math.min(100, percent) / 100)).toFixed(2);
  const color = percent >= 100 ? 'var(--green)' : 'var(--purple)';
  const textColor = percent >= 100 ? 'var(--green)' : 'var(--purple)';
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="flex-shrink:0" aria-hidden="true">
    <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="var(--border)" stroke-width="3.5"/>
    <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="${color}" stroke-width="3.5"
      stroke-dasharray="${circ}" stroke-dashoffset="${offset}"
      stroke-linecap="round" transform="rotate(-90 ${size/2} ${size/2})"/>
    <text x="${size/2}" y="${size/2}" text-anchor="middle" dominant-baseline="central"
      font-size="${Math.round(size * 0.21)}px" font-weight="700" fill="${textColor}" font-family="inherit">${percent}%</text>
  </svg>`;
}

function emptyStateIllustration(type) {
  const w = 72, h = 72;
  const illustrations = {
    transactions: `<svg width="${w}" height="${h}" viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="72" height="72" rx="18" fill="var(--purple-faint)"/>
      <ellipse cx="36" cy="42" rx="16" ry="13" fill="white" stroke="var(--purple)" stroke-width="1.5"/>
      <circle cx="47" cy="35" rx="7" ry="7" fill="white" stroke="var(--purple)" stroke-width="1.5"/>
      <ellipse cx="49" cy="38" rx="3.5" ry="2.5" fill="var(--purple-faint)" stroke="var(--purple)" stroke-width="1"/>
      <circle cx="48" cy="32" r="1" fill="var(--purple)"/>
      <rect x="31" y="25" width="6" height="1.5" rx="0.75" fill="var(--purple)" opacity="0.5"/>
      <path d="M20 42 Q15 39 15 44 Q15 49 20 47" stroke="var(--purple)" stroke-width="1.5" stroke-linecap="round" fill="none"/>
      <line x1="29" y1="54" x2="28" y2="59" stroke="var(--purple)" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="43" y1="54" x2="44" y2="59" stroke="var(--purple)" stroke-width="1.5" stroke-linecap="round"/>
      <circle cx="56" cy="20" r="5" fill="var(--yellow-faint)" stroke="var(--yellow)" stroke-width="1.5"/>
      <line x1="56" y1="17" x2="56" y2="23" stroke="var(--yellow)" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="53" y1="20" x2="59" y2="20" stroke="var(--yellow)" stroke-width="1" stroke-linecap="round"/>
    </svg>`,
    goals: `<svg width="${w}" height="${h}" viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="72" height="72" rx="18" fill="var(--purple-faint)"/>
      <path d="M36 52 Q30 44 20 40 Q28 36 36 20 Q44 36 52 40 Q42 44 36 52Z" fill="white" stroke="var(--purple)" stroke-width="1.5" stroke-linejoin="round"/>
      <circle cx="36" cy="38" r="5" fill="var(--purple-faint)" stroke="var(--purple)" stroke-width="1.5"/>
      <circle cx="36" cy="38" r="2" fill="var(--purple)"/>
      <line x1="36" y1="52" x2="36" y2="60" stroke="var(--purple)" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="30" y1="60" x2="42" y2="60" stroke="var(--purple)" stroke-width="2" stroke-linecap="round"/>
    </svg>`,
    wishlist: `<svg width="${w}" height="${h}" viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="72" height="72" rx="18" fill="var(--purple-faint)"/>
      <path d="M24 28 L20 20 H16" stroke="var(--purple)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M24 28 L28 44 H52 L56 28 Z" fill="white" stroke="var(--purple)" stroke-width="1.5" stroke-linejoin="round"/>
      <circle cx="30" cy="50" r="3" fill="var(--purple-faint)" stroke="var(--purple)" stroke-width="1.5"/>
      <circle cx="48" cy="50" r="3" fill="var(--purple-faint)" stroke="var(--purple)" stroke-width="1.5"/>
      <path d="M36 22 L37.8 27.5 H43.5 L38.9 30.8 L40.7 36.3 L36 33 L31.3 36.3 L33.1 30.8 L28.5 27.5 H34.2 Z" fill="var(--yellow-faint)" stroke="var(--yellow)" stroke-width="1" stroke-linejoin="round"/>
    </svg>`,
    recurring: `<svg width="${w}" height="${h}" viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="72" height="72" rx="18" fill="var(--purple-faint)"/>
      <rect x="16" y="22" width="40" height="34" rx="6" fill="white" stroke="var(--purple)" stroke-width="1.5"/>
      <line x1="16" y1="31" x2="56" y2="31" stroke="var(--purple)" stroke-width="1.5"/>
      <line x1="26" y1="16" x2="26" y2="26" stroke="var(--purple)" stroke-width="2" stroke-linecap="round"/>
      <line x1="46" y1="16" x2="46" y2="26" stroke="var(--purple)" stroke-width="2" stroke-linecap="round"/>
      <path d="M28 44 Q36 38 44 44" stroke="var(--purple)" stroke-width="1.5" stroke-linecap="round" fill="none"/>
      <polyline points="42 41 44 44 41 46" stroke="var(--purple)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,
    chores: `<svg width="${w}" height="${h}" viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="72" height="72" rx="18" fill="var(--purple-faint)"/>
      <rect x="18" y="16" width="36" height="44" rx="6" fill="white" stroke="var(--purple)" stroke-width="1.5"/>
      <rect x="28" y="12" width="16" height="8" rx="4" fill="var(--purple)" opacity="0.7"/>
      <line x1="28" y1="30" x2="44" y2="30" stroke="var(--border)" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="28" y1="38" x2="44" y2="38" stroke="var(--border)" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="28" y1="46" x2="38" y2="46" stroke="var(--border)" stroke-width="1.5" stroke-linecap="round"/>
      <path d="M24 29 L26 31 L30 27" stroke="var(--green)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M24 37 L26 39 L30 35" stroke="var(--green)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,
  };
  return illustrations[type] || illustrations.transactions;
}

// ─── Category Icons ───────────────────────────────────────────
const CAT_ICON_PATHS = {
  'cash':       `<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>`,
  'gift-card':  `<polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>`,
  'allowance':  `<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>`,
  'birthday':   `<path d="M20 21v-8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8"/><path d="M4 16s.5-1 2-1 2.5 2 4 2 2.5-2 4-2 2 1 2 1"/><line x1="12" y1="11" x2="12" y2="3"/><path d="m9.5 3 2.5 3 2.5-3"/>`,
  'chores':     `<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>`,
  'other-in':   `<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>`,
  'toy':        `<circle cx="12" cy="12" r="10"/><path d="M8 13s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>`,
  'game':       `<line x1="6" y1="12" x2="10" y2="12"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="15" y1="13" x2="15.01" y2="13"/><line x1="18" y1="11" x2="18.01" y2="11"/><rect x="2" y="6" width="20" height="12" rx="2"/>`,
  'food':       `<path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/>`,
  'clothes':    `<path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.57a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.57a2 2 0 0 0-1.34-2.23z"/>`,
  'book':       `<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>`,
  'other-out':  `<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>`,
};

const CATEGORIES = {
  income: [
    { value: 'cash',      label: 'Cash',           icon: '💵' },
    { value: 'gift-card', label: 'Gift Card',       icon: '🎁' },
    { value: 'allowance', label: 'Allowance',       icon: '📅' },
    { value: 'birthday',  label: 'Birthday Money',  icon: '🎂' },
    { value: 'chores',    label: 'Chore Payment',   icon: '🧹' },
    { value: 'other-in',  label: 'Other',           icon: '💰' },
  ],
  expense: [
    { value: 'toy',       label: 'Toy',             icon: '🧸' },
    { value: 'game',      label: 'Game',            icon: '🎮' },
    { value: 'food',      label: 'Food/Treats',     icon: '🍕' },
    { value: 'clothes',   label: 'Clothes',         icon: '👕' },
    { value: 'book',      label: 'Book',            icon: '📚' },
    { value: 'other-out', label: 'Other',           icon: '🛒' },
  ],
};

function getCategoryIcon(type, category) {
  const paths = CAT_ICON_PATHS[category];
  if (paths) return svgIcon(paths, 18);
  return svgIcon(type === 'income'
    ? `<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>`
    : `<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>`, 18);
}

// ─── Navigation ──────────────────────────────────────────────
window.navigateTo = function(view) {
  currentView = view;
  window.scrollTo(0, 0);
  render();
};

// ─── Rendering ────────────────────────────────────────────────
function render() {
  const app = document.getElementById('app');

  if (contributorRole === 'contributor') {
    app.innerHTML = renderContributorShell();
    return;
  }

  // Auth loading state (initial check)
  if (!appReady) {
    app.innerHTML = '<div class="auth-loading"><div class="auth-spinner"></div></div>';
    return;
  }

  // Not signed in — show login screen
  if (!currentUser) {
    app.innerHTML = renderLoginScreen();
    return;
  }

  // Kid Mode: show PIN lock screen
  if (kidModeEnabled && kidModeLocked) {
    app.innerHTML = renderPinLockScreen();
    return;
  }

  const kidMode = isInKidMode();
  // In kid mode, block settings access
  const effectiveView = (kidMode && currentView === 'settings') ? 'home' : currentView;

  let pageContent = '';
  switch (effectiveView) {
    case 'home':     pageContent = renderHomePage(); break;
    case 'activity': pageContent = renderActivityPage(); break;
    case 'goals':    pageContent = renderGoalsPage(); break;
    case 'settings': pageContent = renderSettingsPage(); break;
    case 'chores':   pageContent = renderChoresPage(); break;
    default:         pageContent = renderHomePage(); break;
  }

  app.innerHTML = `
    <div class="page-content">
      ${renderHeader()}
      ${(!kidMode && effectiveView !== 'settings' && effectiveView !== 'chores') ? renderKidTabs() : ''}
      ${pageContent}
    </div>
    ${kidMode ? renderKidModeBottomNav() : renderBottomNav()}
  `;

  app.innerHTML += renderModal();
  app.innerHTML += renderConfirm();
  if (kidMode) app.innerHTML += renderParentUnlockModal();
  bindEvents();
}

// ─── Login Screen ─────────────────────────────────────────────
function renderLoginScreen() {
  const isSignup = authMode === 'signup';
  const isReset = authMode === 'reset';
  const errorHtml = authError
    ? `<div class="auth-error">${escapeHtml(authError)}</div>`
    : '';
  const messageHtml = authMessage
    ? `<div class="auth-message">${escapeHtml(authMessage)}</div>`
    : '';

  if (isReset) {
    return `
      <div class="login-screen">
        <div class="login-card">
          <div class="login-logo">
            <h1>💰 KidCash</h1>
            <p>Reset Your Password</p>
          </div>
          <div class="login-form">
            ${errorHtml}
            ${messageHtml}
            <input class="login-input" type="email" id="authEmail" placeholder="Email address" autocomplete="email" autocapitalize="off">
            <button class="login-btn" onclick="handleForgotPassword()" ${authBusy ? 'disabled' : ''}>
              ${authBusy ? 'Please wait...' : 'Send Reset Link'}
            </button>
            <div class="login-toggle">
              <button onclick="setAuthMode('login')">Back to Sign In</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  return `
    <div class="login-screen">
      <div class="login-card">
        <div class="login-logo">
          <h1>💰 KidCash</h1>
          <p>Family Money Tracker</p>
        </div>
        <div class="login-form">
          ${errorHtml}
          ${messageHtml}
          <input class="login-input" type="email" id="authEmail" placeholder="Email address" autocomplete="email" autocapitalize="off">
          <input class="login-input" type="password" id="authPassword" placeholder="Password" autocomplete="${isSignup ? 'new-password' : 'current-password'}">
          ${isSignup ? '<input class="login-input" type="password" id="authPasswordConfirm" placeholder="Confirm password" autocomplete="new-password">' : ''}
          <button class="login-btn" onclick="handleAuth()" ${authBusy ? 'disabled' : ''}>
            ${authBusy ? 'Please wait...' : (isSignup ? 'Create Account' : 'Sign In')}
          </button>
          ${!isSignup ? '<div class="forgot-password"><button onclick="setAuthMode(\'reset\')">Forgot password?</button></div>' : ''}
          <div class="login-divider">or</div>
          <button class="google-btn" onclick="handleGoogleSignIn()" ${authBusy ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
            Continue with Google
          </button>
          <div class="login-toggle">
            ${isSignup
              ? 'Already have an account? <button onclick="toggleAuthMode()">Sign In</button>'
              : 'Don\'t have an account? <button onclick="toggleAuthMode()">Sign Up</button>'
            }
          </div>
        </div>
      </div>
    </div>
  `;
}

// ─── PIN Lock Screen ─────────────────────────────────────────
function renderPinLockScreen() {
  const kidsWithPins = state.kids
    .map((kid, i) => ({ ...kid, index: i }))
    .filter(kid => kid.pin && (isPinHash(kid.pin) || kid.pin.length === 4));

  if (kidsWithPins.length === 0) {
    // No kids have PINs — auto-disable Kid Mode
    kidModeEnabled = false;
    localStorage.setItem('kidcash_kidmode', 'false');
    kidModeLocked = false;
    render();
    return '<div class="auth-loading"><div class="auth-spinner"></div></div>';
  }

  if (kidModeSelectedKid === null) {
    // Phase 1: kid selection
    return `
      <div class="pin-lock-screen">
        <div class="pin-lock-card">
          <div class="pin-lock-logo">
            <h1 class="pin-logo">KidCash</h1>
            <p>Who's using the app?</p>
          </div>
          <div class="pin-kid-buttons">
            ${kidsWithPins.map(kid => `
              <button class="pin-kid-btn" onclick="selectKidForPin(${kid.index})">
                ${kidAvatarHtml(kid.name, 52)}
                <span class="pin-kid-name">${escapeHtml(kid.name)}</span>
              </button>
            `).join('')}
          </div>
          <button class="pin-parent-btn" onclick="showParentUnlockFn()">🔒 Parent Mode</button>
        </div>
      </div>
      ${renderParentUnlockModal()}
    `;
  }

  // Phase 2: PIN entry
  const kid = state.kids[kidModeSelectedKid];
  const dots = Array.from({ length: 4 }, (_, i) =>
    `<div class="pin-dot ${i < kidModePinEntry.length ? 'filled' : ''}"></div>`
  ).join('');

  return `
    <div class="pin-lock-screen">
      <div class="pin-lock-card">
        <button class="pin-back-btn" onclick="clearPinSelection()">← Back</button>
        <div class="pin-lock-logo">
          ${kidAvatarHtml(kid.name, 64)}
          <p>${escapeHtml(kid.name)}</p>
        </div>
        <div class="pin-dots">${dots}</div>
        ${kidModePinError ? `<div class="pin-error">${escapeHtml(kidModePinError)}</div>` : ''}
        <div class="pin-keypad">
          ${[1,2,3,4,5,6,7,8,9].map(n => `
            <button class="pin-key" onclick="enterPinDigit('${n}')">${n}</button>
          `).join('')}
          <div class="pin-key-spacer"></div>
          <button class="pin-key" onclick="enterPinDigit('0')">0</button>
          <button class="pin-key" onclick="deletePinDigit()">⌫</button>
        </div>
        <button class="pin-parent-btn" onclick="showParentUnlockFn()">🔒 Parent Mode</button>
      </div>
    </div>
    ${renderParentUnlockModal()}
  `;
}

// ─── Shared Components ───────────────────────────────────────
const LOGO_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28" style="display:block;flex-shrink:0">
  <defs>
    <linearGradient id="lmBg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#7B6CF6"/>
      <stop offset="100%" stop-color="#4A3CC7"/>
    </linearGradient>
  </defs>
  <rect width="28" height="28" rx="7" fill="url(#lmBg)"/>
  <circle cx="14" cy="14" r="7.5" fill="rgba(255,255,255,0.12)" stroke="rgba(255,255,255,0.22)" stroke-width="1"/>
  <line x1="14" y1="18" x2="14" y2="10" stroke="white" stroke-width="2" stroke-linecap="round"/>
  <polyline points="10,13 14,10 18,13" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</svg>`;

function renderHeader() {
  const titles = {
    home:     null,
    activity: 'Activity',
    goals:    'Goals & Wishlist',  // kept for header display
    settings: 'Settings',
    chores:   'Chores',
  };
  const syncIndicator = syncStatus === 'error'
    ? '<span class="sync-error" title="Changes saved locally but not syncing to cloud">⚠️ Offline</span>'
    : '';
  const title = titles[currentView];
  return `
    <div class="header">
      ${title === null ? `
        <div class="header-logo">
          ${LOGO_MARK_SVG}
          <span class="header-logo-text"><span class="header-logo-kid">Kid</span><span class="header-logo-cash">Cash</span></span>
        </div>
      ` : `<h1>${title}</h1>`}
      ${syncIndicator}
    </div>
  `;
}

function renderKidTabs() {
  return `
    <div class="kid-tabs">
      ${state.kids.map((kid, i) => `
        <button class="kid-tab ${i === state.activeKidIndex ? 'active' : ''}"
                onclick="switchKid(${i})">${escapeHtml(kid.name)}</button>
      `).join('')}
    </div>
  `;
}

function renderBottomNav() {
  const tabs = [
    { id: 'home',     icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>', label: 'Home' },
    { id: 'activity', icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>', label: 'Activity' },
    { id: 'goals',    icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle></svg>', label: 'Goals' },
    { id: 'chores',   icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>', label: 'Chores' },
    { id: 'settings', icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>', label: 'Settings' },
  ];

  const pendingChores = (state.chores || []).filter(c => c.status === 'pending').length;
  const pendingFamilyChores = Object.values(pendingChoresCache).reduce((sum, v) => sum + (v ? Object.keys(v).length : 0), 0);
  const totalPendingChores = pendingChores + pendingFamilyChores;
  return `
    <nav class="bottom-nav">
      ${tabs.map(tab => `
        <button class="bottom-nav-tab ${currentView === tab.id ? 'active' : ''}"
                onclick="navigateTo('${tab.id}')">
          <span class="bottom-nav-icon-wrap">
            ${tab.icon}
            ${tab.id === 'chores' && totalPendingChores > 0 ? `<span class="nav-badge">${totalPendingChores}</span>` : ''}
          </span>
          <span class="bottom-nav-label">${tab.label}</span>
        </button>
      `).join('')}
    </nav>
  `;
}

function renderKidModeBottomNav() {
  const tabs = [
    { id: 'home',     icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>', label: 'Home' },
    { id: 'activity', icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>', label: 'Activity' },
    { id: 'goals',    icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle></svg>', label: 'Goals' },
    { id: 'chores',   icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>', label: 'Chores' },
    { id: 'lock',     icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>', label: 'Lock' },
  ];

  return `
    <nav class="bottom-nav">
      ${tabs.map(tab => {
        if (tab.id === 'lock') {
          return `
            <button class="bottom-nav-tab" onclick="lockKidMode()">
              <span class="bottom-nav-icon">${tab.icon}</span>
              <span class="bottom-nav-label">${tab.label}</span>
            </button>
          `;
        }
        return `
          <button class="bottom-nav-tab ${currentView === tab.id ? 'active' : ''}"
                  onclick="navigateTo('${tab.id}')">
            <span class="bottom-nav-icon">${tab.icon}</span>
            <span class="bottom-nav-label">${tab.label}</span>
          </button>
        `;
      }).join('')}
    </nav>
  `;
}

// ─── Home Page ────────────────────────────────────────────────
function renderHomePage() {
  const kid = getActiveKid();
  if (!kid) return '<p>No kids set up.</p>';
  const balance = getBalance(kid.id);
  const income = getTotalIncome(kid.id);
  const expenses = getTotalExpenses(kid.id);
  const transactions = getKidTransactions(kid.id).slice(0, 3);
  const goals = getKidGoals(kid.id);
  const wishlist = getKidWishlist(kid.id);

  return `
    ${renderBalanceCard(kid, balance, income, expenses)}
    ${renderQuickActions()}
    ${renderChoresSnapshot(kid, balance)}
    ${renderGoalsSnapshot(goals, balance)}
    ${renderWishlistSnapshot(wishlist)}
    ${renderRecentActivitySnapshot(transactions)}
  `;
}

function renderChoresSnapshot(kid, balance) {
  if (isInKidMode()) {
    const myChores = getKidChores(kid.id);
    const available = myChores.filter(c => c.status === 'available');
    const pending = myChores.filter(c => c.status === 'pending');
    if (available.length === 0 && pending.length === 0) return '';
    const items = [...available, ...pending].slice(0, 3);
    return `
      <div class="section" onclick="navigateTo('chores')" style="cursor:pointer">
        <div class="section-header">
          <h3 class="section-title">Chores</h3>
          <button class="section-link" onclick="event.stopPropagation();navigateTo('chores')">See All</button>
        </div>
        <div class="transaction-list">
          ${items.map(c => {
            const isPending = c.status === 'pending';
            return `
              <div class="transaction-item${isPending ? ' chore-pending-item' : ''}">
                <div class="tx-icon income">${svgIcon(SVG.broom)}</div>
                <div class="tx-details">
                  <div class="tx-description">${escapeHtml(c.name)}</div>
                  <div class="tx-date">${isPending ? '⏳ Awaiting approval' : `→ ${formatMoney(balance + c.amount)} after`}</div>
                </div>
                <div class="tx-amount income">${isPending ? '⏳' : `+${formatMoney(c.amount)}`}</div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  } else {
    const pending = (state.chores || []).filter(c => c.status === 'pending');
    const available = (state.chores || []).filter(c => c.status === 'available');
    if (pending.length === 0 && available.length === 0) return '';
    const items = pending.length > 0 ? pending.slice(0, 3) : available.slice(0, 3);
    return `
      <div class="section" onclick="navigateTo('chores')" style="cursor:pointer">
        <div class="section-header">
          <h3 class="section-title">Chores${pending.length > 0 ? ` <span class="approval-badge">${pending.length}</span>` : ''}</h3>
          <button class="section-link" onclick="event.stopPropagation();navigateTo('chores')">See All</button>
        </div>
        <div class="transaction-list">
          ${items.map(c => {
            const choreKid = state.kids.find(k => k.id === c.kidId);
            const kidName = choreKid ? escapeHtml(choreKid.name) : 'Unknown';
            const isPending = c.status === 'pending';
            return `
              <div class="transaction-item${isPending ? ' chore-pending-item' : ''}">
                <div class="tx-icon income">${svgIcon(SVG.broom)}</div>
                <div class="tx-details">
                  <div class="tx-description">${escapeHtml(c.name)}</div>
                  <div class="tx-date">${kidName}${isPending ? ' · ⏳ Needs approval' : ''}</div>
                </div>
                ${isPending ? `
                  <div class="chore-approval-btns" onclick="event.stopPropagation()">
                    <button class="chore-approve-btn" onclick="approveChore('${sanitizeId(c.id)}')">✓</button>
                    <button class="chore-reject-btn" onclick="rejectChore('${sanitizeId(c.id)}')">✕</button>
                  </div>
                ` : `<div class="tx-amount income">+${formatMoney(c.amount)}</div>`}
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }
}

function renderBalanceCard(kid, balance, income, expenses) {
  const chipSvg = `<svg width="32" height="24" viewBox="0 0 32 24" fill="none"><rect width="32" height="24" rx="4" fill="rgba(255,255,255,0.22)"/><rect y="8" width="32" height="8" fill="rgba(255,255,255,0.07)"/><rect x="12" width="8" height="24" fill="rgba(255,255,255,0.07)"/><rect x="1" y="1" width="13" height="10" rx="1" stroke="rgba(255,255,255,0.35)" stroke-width="0.75" fill="none"/><rect x="18" y="1" width="13" height="10" rx="1" stroke="rgba(255,255,255,0.35)" stroke-width="0.75" fill="none"/><rect x="1" y="13" width="13" height="10" rx="1" stroke="rgba(255,255,255,0.35)" stroke-width="0.75" fill="none"/><rect x="18" y="13" width="13" height="10" rx="1" stroke="rgba(255,255,255,0.35)" stroke-width="0.75" fill="none"/></svg>`;
  return `
    <div class="balance-card">
      <div class="balance-card-header">
        ${chipSvg}
        <div class="balance-card-name">${escapeHtml(kid.name)}</div>
        ${kidAvatarHtml(kid.name, 32)}
      </div>
      <div class="balance-label">Current Balance</div>
      <div class="balance-amount">${formatMoney(balance)}</div>
      <div class="balance-stats">
        <div class="balance-stat">
          <span class="stat-dot income"></span>
          In: ${formatMoney(income)}
        </div>
        <div class="balance-stat">
          <span class="stat-dot expense"></span>
          Out: ${formatMoney(expenses)}
        </div>
      </div>
    </div>
  `;
}

function renderQuickActions() {
  return `
    <div class="quick-actions">
      ${isInKidMode() ? '' : '<button class="action-btn add" onclick="openTransactionModal(\'income\')">+ Add</button>'}
      <button class="action-btn spend" onclick="openTransactionModal('expense')">- Spend</button>
      <button class="action-btn goal" onclick="navigateTo('goals')">Goals</button>
    </div>
  `;
}

function renderGoalsSnapshot(goals, balance) {
  if (goals.length === 0) return '';
  return `
    <div class="section">
      <div class="section-header">
        <h3 class="section-title">Goals</h3>
        <button class="section-link" onclick="navigateTo('goals')">See All</button>
      </div>
      <div class="goals-list">
        ${goals.slice(0, 2).map(g => renderGoalCardCompact(g, balance)).join('')}
      </div>
    </div>
  `;
}

function renderGoalCardCompact(goal, balance) {
  const tax = calcTax(goal.target, selectedState);
  const effectiveTarget = goal.target + tax;
  const percent = effectiveTarget > 0 ? Math.min(100, Math.round((balance / effectiveTarget) * 100)) : 0;
  const isComplete = percent >= 100;
  const remaining = balance - effectiveTarget;
  return `
    <div class="goal-card compact" onclick="navigateTo('goals')">
      <div class="goal-card-inner">
        ${progressRing(percent)}
        <div class="goal-card-text">
          <div class="goal-name">${escapeHtml(goal.name)}</div>
          <div class="goal-amount">${formatMoney(balance)} / ${formatMoney(effectiveTarget)}${tax > 0 ? ' <span class="goal-tax-badge">incl. tax</span>' : ''}</div>
          <div class="goal-balance-after ${remaining < 0 ? 'negative' : ''}">
            ${isComplete ? `🎉 Goal reached! ${formatMoney(remaining)} left` : `Need ${formatMoney(Math.abs(remaining))} more`}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderWishlistSnapshot(wishlist) {
  if (wishlist.length === 0) return '';
  return `
    <div class="section">
      <div class="section-header">
        <h3 class="section-title">Wishlist</h3>
        <button class="section-link" onclick="navigateTo('goals')">See All</button>
      </div>
      <div class="wishlist-list">
        ${wishlist.slice(0, 2).map(w => renderWishlistCardCompact(w)).join('')}
      </div>
    </div>
  `;
}

function renderWishlistCardCompact(item) {
  const hasImage = item.image;
  const tax = calcTax(item.price, selectedState);
  const taxLine = tax > 0 ? `<div class="wishlist-price-withtax">~${formatMoney(item.price + tax)} with tax</div>` : '';
  return `
    <div class="wishlist-card compact" onclick="navigateTo('goals')">
      <div class="wishlist-top">
        ${hasImage ? `<img class="wishlist-image" src="${escapeHtml(item.image)}" alt="" onerror="this.style.display='none'">` : ''}
        <div class="wishlist-info">
          <div class="wishlist-name">${escapeHtml(item.name)}</div>
          <div class="wishlist-price">${formatMoney(item.price)}</div>
          ${taxLine}
        </div>
      </div>
    </div>
  `;
}

function renderRecentActivitySnapshot(transactions) {
  return `
    <div class="section">
      <div class="section-header">
        <h3 class="section-title">Recent Activity</h3>
        ${transactions.length > 0 ? `
          <button class="section-link" onclick="navigateTo('activity')">See All</button>
        ` : ''}
      </div>
      ${transactions.length > 0 ? `
        <div class="transaction-list">
          ${transactions.map(t => renderTransaction(t)).join('')}
        </div>
      ` : `
        <div class="empty-state">
          ${emptyStateIllustration('transactions')}
          <p>No transactions yet</p>
          <p>Add some money to get started!</p>
        </div>
      `}
    </div>
  `;
}

// ─── Chore Snapshots ─────────────────────────────────────────
function renderKidChoresSnapshot(chores) {
  const available = chores.filter(c => c.status === 'available');
  const pending = chores.filter(c => c.status === 'pending');
  if (available.length === 0 && pending.length === 0) return '';
  return `
    <div class="section">
      <div class="section-header">
        <h3 class="section-title">My Chores</h3>
      </div>
      <div class="chore-list">
        ${available.map(c => `
          <div class="chore-item">
            <div class="chore-info">
              <div class="chore-name">${escapeHtml(c.name)}</div>
              <div class="chore-amount">+${formatMoney(c.amount)}</div>
            </div>
            <button class="chore-done-btn" onclick="markChoreDone('${sanitizeId(c.id)}')">Done!</button>
          </div>
        `).join('')}
        ${pending.map(c => `
          <div class="chore-item pending">
            <div class="chore-info">
              <div class="chore-name">${escapeHtml(c.name)}</div>
              <div class="chore-amount">+${formatMoney(c.amount)}</div>
            </div>
            <span class="chore-pending-badge">⏳ Awaiting parent approval</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderPendingApprovalsSnapshot() {
  const pending = (state.chores || []).filter(c => c.status === 'pending');
  if (pending.length === 0) return '';
  return `
    <div class="section">
      <div class="section-header">
        <h3 class="section-title">🧹 Chore Approvals</h3>
        <span class="approval-badge">${pending.length}</span>
      </div>
      <div class="chore-list">
        ${pending.map(c => {
          const kid = state.kids.find(k => k.id === c.kidId);
          const kidName = kid ? escapeHtml(kid.name) : 'Unknown';
          return `
            <div class="chore-item approval">
              <div class="chore-info">
                <div class="chore-name">${escapeHtml(c.name)}</div>
                <div class="chore-amount">${kidName} · +${formatMoney(c.amount)}</div>
              </div>
              <div class="chore-approval-btns">
                <button class="chore-approve-btn" onclick="approveChore('${sanitizeId(c.id)}')">✓</button>
                <button class="chore-reject-btn" onclick="rejectChore('${sanitizeId(c.id)}')">✕</button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

// ─── Activity Page ────────────────────────────────────────────
function renderActivityPage() {
  const kid = getActiveKid();
  if (!kid) return '<p>No kids set up.</p>';

  return `
    ${isInKidMode() ? '' : `
      <div class="activity-tabs">
        <button class="activity-tab ${activityTab === 'history' ? 'active' : ''}" onclick="setActivityTab('history')">History</button>
        <button class="activity-tab ${activityTab === 'recurring' ? 'active' : ''}" onclick="setActivityTab('recurring')">Recurring</button>
      </div>
    `}
    ${activityTab === 'recurring' && !isInKidMode() ? renderRecurringView(kid) : renderHistoryView(kid)}
  `;
}

function renderHistoryView(kid) {
  const transactions = getKidTransactions(kid.id);
  return `
    <div class="page-actions">
      ${isInKidMode() ? '' : '<button class="action-btn add" onclick="openTransactionModal(\'income\')">+ Add Money</button>'}
      <button class="action-btn spend" onclick="openTransactionModal('expense')">- Spend</button>
    </div>
    ${transactions.length > 0 ? `
      <div class="transaction-list">
        ${transactions.map(t => renderTransaction(t)).join('')}
      </div>
    ` : `
      <div class="empty-state">
        ${emptyStateIllustration('transactions')}
        <p>No transactions yet</p>
        <p>All of ${escapeHtml(kid.name)}'s money activity will appear here.</p>
      </div>
    `}
  `;
}

function renderRecurringView(kid) {
  const recurring = (state.recurringActivities || []).filter(r => r.kidId === kid.id);
  const freqLabel = f => f === 'weekly' ? 'Weekly' : f === 'biweekly' ? 'Every 2 weeks' : 'Monthly';
  return `
    <div class="page-actions">
      <button class="action-btn add" onclick="openModal('recurring')">+ Add Recurring</button>
    </div>
    ${recurring.length === 0 ? `
      <div class="empty-state">
        ${emptyStateIllustration('recurring')}
        <p>No recurring activities</p>
        <p style="font-size:14px;color:var(--text-secondary);margin-top:8px">Set up allowance, subscriptions, or any regular income or expense that should happen automatically.</p>
      </div>
    ` : `
      <div class="recurring-list">
        ${recurring.map(r => {
          const icon = getCategoryIcon(r.type, r.category);
          const nextDate = new Date(r.nextDue).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          return `
            <div class="recurring-card ${r.active ? '' : 'inactive'}">
              <div class="recurring-card-icon ${r.type}">${icon}</div>
              <div class="recurring-card-body">
                <div class="recurring-card-name">${escapeHtml(r.description)}</div>
                <div class="recurring-card-meta">${freqLabel(r.frequency)} · ${r.type === 'income' ? '+' : '-'}${formatMoney(r.amount)}</div>
                <div class="recurring-card-next">${r.active ? `Next: ${nextDate}` : 'Paused'}</div>
              </div>
              <div class="recurring-card-actions">
                <button class="chore-edit-btn" onclick="openEditRecurringModal('${sanitizeId(r.id)}')">✏️</button>
                <button class="toggle-switch ${r.active ? 'active' : ''}" onclick="toggleRecurringActive('${sanitizeId(r.id)}')">
                  <span class="toggle-knob"></span>
                </button>
                <button class="tx-delete" onclick="confirmDeleteRecurring('${sanitizeId(r.id)}')">✕</button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `}
  `;
}

// ─── Goals Page ───────────────────────────────────────────────
function renderGoalsPage() {
  const kid = getActiveKid();
  if (!kid) return '<p>No kids set up.</p>';
  const balance = getBalance(kid.id);
  const goals = getKidGoals(kid.id);
  const wishlist = getKidWishlist(kid.id);

  // Auto-load claims when sharing is active
  const shareToken = (state.wishlistShares || {})[kid.id];
  if (shareToken && wishlistClaimsCache[kid.id] === undefined) {
    wishlistClaimsCache[kid.id] = null; // mark loading
    loadClaimsForKid(kid.id, shareToken);
  }
  const kidClaims = wishlistClaimsCache[kid.id] || {};

  return `
    <div class="page-actions">
      <button class="action-btn wishlist-add" onclick="openWishlistModal()">+ Add Item</button>
    </div>

    <div class="section">
      <div class="section-header-stack">
        <h3 class="section-title">Goals</h3>
        <p class="section-subtitle">Things you're actively saving for</p>
      </div>
      ${goals.length > 0 ? `
        <div class="goals-list">
          ${goals.map(g => renderGoalCard(g, balance)).join('')}
        </div>
      ` : `
        <div class="empty-state">
          ${emptyStateIllustration('goals')}
          <p>No goals yet</p>
          <p>Add something to your wishlist and tap "Set as Goal" to start tracking your savings.</p>
        </div>
      `}
    </div>

    <div class="section">
      <div class="section-header-row">
        <div class="section-header-stack">
          <h3 class="section-title">Wishlist</h3>
          <p class="section-subtitle">Things you want — tap "Set as Goal" when you're ready to start saving</p>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          ${shareToken ? `<button class="claims-refresh-inline-btn" onclick="refreshKidClaims('${sanitizeId(kid.id)}')" title="Refresh gift status">↻</button>` : ''}
          <button class="wishlist-share-toggle-btn ${shareToken ? 'active' : ''}" onclick="openWishlistShare('${sanitizeId(kid.id)}')">
            ${svgIcon('<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>', 15)} ${shareToken ? 'Shared' : 'Share'}
          </button>
        </div>
      </div>
      ${wishlist.length > 0 ? `
        <div class="wishlist-list">
          ${wishlist.map(w => renderWishlistCard(w, balance, kidClaims[w.id] || null)).join('')}
        </div>
      ` : `
        <div class="empty-state">
          ${emptyStateIllustration('wishlist')}
          <p>Nothing on the wishlist yet</p>
          <p>Add something you want, then set it as a goal when you're ready to save for it.</p>
        </div>
      `}
    </div>
  `;
}

// ─── Chore Progression ───────────────────────────────────────
const CHORE_LEVELS = [
  { level: 1, name: 'Helper',          emoji: '🌱', min: 0,  next: 5  },
  { level: 2, name: 'Helping Hand',    emoji: '🌿', min: 5,  next: 10 },
  { level: 3, name: 'Hard Worker',     emoji: '⭐', min: 10, next: 20 },
  { level: 4, name: 'Super Star',      emoji: '🌟', min: 20, next: 35 },
  { level: 5, name: 'Chore Champion',  emoji: '🏆', min: 35, next: 50 },
  { level: 6, name: 'Legend',          emoji: '👑', min: 50, next: null },
];

function getChoreStats(kidId) {
  const completed = state.transactions.filter(t =>
    t.kidId === kidId && t.category === 'chores' && t.type === 'income'
  ).length;
  const levelData = CHORE_LEVELS.slice().reverse().find(l => completed >= l.min) || CHORE_LEVELS[0];
  const nextLevel = CHORE_LEVELS.find(l => l.level === levelData.level + 1) || null;
  const progress = nextLevel
    ? Math.round(((completed - levelData.min) / (nextLevel.min - levelData.min)) * 100)
    : 100;
  return { completed, levelData, nextLevel, progress };
}

function renderChoreProgressBanner(kidId) {
  const { completed, levelData, nextLevel, progress } = getChoreStats(kidId);
  const remaining = nextLevel ? nextLevel.min - completed : 0;
  return `
    <div class="chore-progress-banner">
      <div class="chore-level-badge">${levelData.emoji} Level ${levelData.level}</div>
      <div class="chore-level-name">${levelData.name}</div>
      <div class="chore-progress-bar-wrap">
        <div class="chore-progress-bar-fill" style="width:${progress}%"></div>
      </div>
      <div class="chore-progress-label">
        ${nextLevel
          ? `${completed} chores · ${remaining} more to reach <strong>${nextLevel.name}</strong>`
          : `🎉 Max level! ${completed} chores completed`}
      </div>
    </div>
  `;
}

// ─── Chores Page ──────────────────────────────────────────────
const SUGGESTED_CHORES = [
  { name: 'Take out trash',      amount: 100 },
  { name: 'Unload dishwasher',   amount: 75 },
  { name: 'Wash dishes',         amount: 150 },
  { name: 'Vacuum',              amount: 200 },
  { name: 'Sweep / mop floor',   amount: 150 },
  { name: 'Clean bedroom',       amount: 100 },
  { name: 'Clean bathroom',      amount: 200 },
  { name: 'Do laundry',          amount: 200 },
  { name: 'Fold laundry',        amount: 100 },
  { name: 'Set the table',       amount: 50 },
  { name: 'Wipe counters',       amount: 75 },
  { name: 'Feed pets',           amount: 50 },
  { name: 'Walk the dog',        amount: 100 },
  { name: 'Water plants',        amount: 50 },
  { name: 'Rake leaves',         amount: 200 },
  { name: 'Mow the lawn',        amount: 500 },
  { name: 'Wash the car',        amount: 300 },
  { name: 'Shovel snow',         amount: 500 },
  { name: 'Take recycling out',  amount: 100 },
  { name: 'Make bed',            amount: 50 },
];

function getChoreTemplates() {
  if (state.choreTemplates) return state.choreTemplates;
  // Return defaults without saving during render — saved on first user action
  return SUGGESTED_CHORES.map(s => ({ id: generateId(), name: s.name, amount: s.amount }));
}

function renderChoresPage() {
  const kidMode = isInKidMode();
  const kid = getActiveKid();
  const allChores = state.chores || [];

  if (kidMode) {
    // ── Kid View ──────────────────────────────────────
    const myChores = allChores.filter(c => c.kidId === kid.id);
    const available = myChores.filter(c => c.status === 'available');
    const pending = myChores.filter(c => c.status === 'pending');
    const balance = getBalance(kid.id);

    // Past approved chores — dedupe by name, keep most recent
    const approvedMap = new Map();
    myChores.filter(c => c.status === 'approved').forEach(c => {
      if (!approvedMap.has(c.name) || c.approvedAt > approvedMap.get(c.name).approvedAt) {
        approvedMap.set(c.name, c);
      }
    });
    // Only show "do again" for chores not currently active or pending
    const activeNames = new Set([...available, ...pending].map(c => c.name));
    const doAgain = [...approvedMap.values()].filter(c => !activeNames.has(c.name));

    if (available.length === 0 && pending.length === 0 && doAgain.length === 0) return `
      ${renderChoreProgressBanner(kid.id)}
      <div class="empty-state" style="margin-top:24px">
        <div class="empty-icon">🧹</div>
        <p>No chores assigned yet. Ask a parent to add some!</p>
      </div>
    `;

    return `
      ${renderChoreProgressBanner(kid.id)}
      <div class="chore-balance-row">
        <span class="chore-balance-label">Your balance</span>
        <span class="chore-balance-amount">${formatMoney(balance)}</span>
      </div>
      ${available.length > 0 ? `
        <div class="section">
          <div class="section-header">
            <h3 class="section-title">Available</h3>
          </div>
          <div class="chore-cards">
            ${available.map(c => `
              <div class="chore-card available">
                <div class="chore-card-icon">🧹</div>
                <div class="chore-card-name">${escapeHtml(c.name)}</div>
                <div class="chore-card-amount">+${formatMoney(c.amount)}</div>
                <div class="chore-card-after">→ ${formatMoney(balance + c.amount)}</div>
                <button class="chore-done-btn" onclick="markChoreDone('${sanitizeId(c.id)}')">Done! ✓</button>
                <button class="chore-skip-btn" onclick="skipChore('${sanitizeId(c.id)}')">Skip</button>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
      ${pending.length > 0 ? `
        <div class="section">
          <div class="section-header">
            <h3 class="section-title">Waiting for Approval</h3>
          </div>
          <div class="chore-cards">
            ${pending.map(c => `
              <div class="chore-card pending">
                <div class="chore-card-icon">⏳</div>
                <div class="chore-card-name">${escapeHtml(c.name)}</div>
                <div class="chore-card-amount">+${formatMoney(c.amount)}</div>
                <div class="chore-card-status">Awaiting parent approval</div>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
      ${doAgain.length > 0 ? `
        <div class="section">
          <div class="section-header">
            <h3 class="section-title">Do Again?</h3>
          </div>
          <div class="chore-cards">
            ${doAgain.map(c => `
              <div class="chore-card do-again">
                <div class="chore-card-icon">🔄</div>
                <div class="chore-card-name">${escapeHtml(c.name)}</div>
                <div class="chore-card-amount">+${formatMoney(c.amount)}</div>
                <div class="chore-card-after">→ ${formatMoney(balance + c.amount)}</div>
                <button class="chore-done-btn" onclick="requestChoreAgain('${sanitizeId(c.id)}')">I did it! ✓</button>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
      ${(() => {
        const activeNames = new Set(myChores.filter(c => c.status === 'available' || c.status === 'pending').map(c => c.name));
        const selfAddable = getChoreTemplates().filter(t => t.kidCanAdd && !activeNames.has(t.name));
        if (selfAddable.length === 0) return '';
        return `
          <div class="section">
            <div class="section-header">
              <h3 class="section-title">Add a Chore</h3>
            </div>
            <div class="chore-cards">
              ${selfAddable.map(t => `
                <div class="chore-card add-from-template">
                  <div class="chore-card-icon">${t.autoApprove ? '⚡' : '🧹'}</div>
                  <div class="chore-card-name">${escapeHtml(t.name)}</div>
                  <div class="chore-card-amount">+${formatMoney(t.amount)}</div>
                  <div class="chore-card-after">→ ${formatMoney(balance + t.amount)}</div>
                  ${t.autoApprove ? '<div class="chore-auto-badge">⚡ Instant credit</div>' : ''}
                  <button class="chore-done-btn secondary" onclick="addChoreFromTemplate('${sanitizeId(t.id)}')">+ Add</button>
                </div>
              `).join('')}
            </div>
          </div>
        `;
      })()}
    `;
  }

  // ── Parent View ──────────────────────────────────────
  // Load pending family chores if not yet loaded
  const choreShareToken = (state.choreShares || {})[getActiveKid()?.id || ''];
  if (choreShareToken) {
    const kidId = getActiveKid()?.id;
    if (kidId && pendingChoresCache[kidId] === undefined) {
      pendingChoresCache[kidId] = null; // mark as loading
      loadPendingChoresForKid(kidId, choreShareToken);
    }
  }
  const activeKidId = getActiveKid()?.id;
  const pendingFamily = activeKidId && pendingChoresCache[activeKidId]
    ? Object.entries(pendingChoresCache[activeKidId])
        .map(([id, data]) => ({ id, ...data }))
        .filter(c => !c.status || c.status === 'pending')  // only show unreviewed
    : [];

  const pendingAll = allChores.filter(c => c.status === 'pending');
  const activeAll = allChores.filter(c => c.status !== 'approved');

  return `
    ${choreShareToken ? `
      ${pendingFamily.length > 0 ? `
        <div class="section chore-family-section">
          <div class="section-header">
            <h3 class="section-title">🏠 Suggested by Family</h3>
            <div style="display:flex;gap:6px;align-items:center">
              <span class="approval-badge">${pendingFamily.length}</span>
              <button class="claims-refresh-inline-btn" onclick="refreshPendingChores('${sanitizeId(activeKidId)}')" title="Refresh">↻</button>
            </div>
          </div>
          <div class="chore-approval-list">
            ${pendingFamily.map(c => `
              <div class="chore-approval-card chore-family-card">
                <div class="chore-approval-info">
                  <div class="chore-approval-name">${escapeHtml(c.name)}</div>
                  <div class="chore-approval-kid">
                    From ${escapeHtml(c.addedBy || 'Family')} · +${formatMoney(c.amount)}
                    ${c.note ? `<div class="chore-family-note">"${escapeHtml(c.note)}"</div>` : ''}
                  </div>
                </div>
                <div class="chore-approval-btns">
                  <button class="chore-approve-btn" onclick="approvePendingChore('${sanitizeId(activeKidId)}', '${sanitizeId(c.id)}')">✓</button>
                  <button class="chore-reject-btn" onclick="rejectPendingChore('${sanitizeId(activeKidId)}', '${sanitizeId(c.id)}')">✕</button>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      ` : pendingChoresCache[activeKidId] === null ? `
        <div class="section"><p style="color:var(--text-muted);font-size:13px;text-align:center;padding:12px">Loading family suggestions…</p></div>
      ` : ''}
    ` : ''}
    ${pendingAll.length > 0 ? `
      <div class="section chore-approvals-section">
        <div class="section-header">
          <h3 class="section-title">⏳ Needs Approval</h3>
          <span class="approval-badge">${pendingAll.length}</span>
        </div>
        <div class="chore-approval-list">
          ${pendingAll.map(c => {
            const kid = state.kids.find(k => k.id === c.kidId);
            const kidName = kid ? escapeHtml(kid.name) : 'Unknown';
            return `
              <div class="chore-approval-card">
                <div class="chore-approval-info">
                  <div class="chore-approval-name">${escapeHtml(c.name)}</div>
                  <div class="chore-approval-kid">${kidName} · +${formatMoney(c.amount)}</div>
                </div>
                <div class="chore-approval-btns">
                  <button class="chore-approve-btn" onclick="approveChore('${sanitizeId(c.id)}')">✓</button>
                  <button class="chore-reject-btn" onclick="rejectChore('${sanitizeId(c.id)}')">✕</button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    ` : ''}

    <div class="section">
      <div class="section-header">
        <h3 class="section-title">Active Chores</h3>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="wishlist-share-toggle-btn ${choreShareToken ? 'active' : ''}" onclick="openChoreShare('${sanitizeId(activeKidId)}')">🏠 Family</button>
          <button class="section-link" onclick="openModal('chore')">+ Add</button>
        </div>
      </div>
      ${activeAll.filter(c => c.status !== 'pending').length === 0 && pendingAll.length === 0 ? `
        <div class="empty-state">
          <div class="empty-icon">🧹</div>
          <p>No chores yet. Add one or pick from suggestions below.</p>
        </div>
      ` : activeAll.filter(c => c.status === 'available').length === 0 ? '' : `
        <div class="chore-list">
          ${activeAll.filter(c => c.status === 'available').map(c => {
            const kid = state.kids.find(k => k.id === c.kidId);
            const kidName = kid ? escapeHtml(kid.name) : 'Unknown';
            return `
              <div class="chore-item">
                <div class="chore-card-icon" style="font-size:20px;margin-right:4px">🧹</div>
                <div class="chore-info">
                  <div class="chore-name">${escapeHtml(c.name)}</div>
                  <div class="chore-amount">${kidName} · +${formatMoney(c.amount)}${c.repeating ? ' · Repeating' : ''}</div>
                </div>
                <div style="display:flex;gap:6px">
                  <button class="chore-edit-btn" onclick="openEditChoreModal('${sanitizeId(c.id)}')">✏️</button>
                  <button class="tx-delete" onclick="confirmDeleteChore('${sanitizeId(c.id)}')">✕</button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `}
    </div>

    <div class="section">
      <div class="section-header">
        <h3 class="section-title">Quick Add</h3>
        <button class="section-link" onclick="openAddTemplateModal()">+ New</button>
      </div>
      <div class="chore-template-list">
        ${getChoreTemplates().map(t => `
          <div class="chore-template-row">
            <div class="chore-template-info">
              <span class="chore-template-name">${escapeHtml(t.name)}</span>
              <span class="chore-template-amount">+${formatMoney(t.amount)}</span>
              <div class="chore-template-flags">
                <button class="chore-flag-btn ${t.kidCanAdd ? 'active' : ''}" onclick="toggleTemplateFlag('${sanitizeId(t.id)}', 'kidCanAdd')" title="Kids can self-add">🧒 Self-add</button>
                <button class="chore-flag-btn ${t.autoApprove ? 'active' : ''}" onclick="toggleTemplateFlag('${sanitizeId(t.id)}', 'autoApprove')" title="Auto-approve on completion">⚡ Auto-approve</button>
              </div>
            </div>
            <div class="chore-template-actions">
              <button class="chore-template-add-btn" onclick="openChoreModalWithSuggestion('${escapeHtml(t.name)}', ${t.amount})">+ Add</button>
              <button class="chore-edit-btn" onclick="openEditTemplateModal('${sanitizeId(t.id)}')">✏️</button>
              <button class="tx-delete" onclick="confirmDeleteTemplate('${sanitizeId(t.id)}')">✕</button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

// ─── Settings Page ────────────────────────────────────────────
function renderSettingsPage() {
  const stateOptions = Object.entries(STATE_TAX_RATES).map(([code, info]) => {
    const rateLabel = code === '' ? '' : (info.rate === 0 ? ' (no tax)' : ` (${info.rate}%)`);
    return `<option value="${code}" ${code === selectedState ? 'selected' : ''}>${code === '' ? '-- No sales tax --' : info.name}${rateLabel}</option>`;
  }).join('');

  return `
    <div class="settings-section">
      <label class="settings-section-label">Kids</label>
      ${state.kids.map((kid, i) => `
        <div class="settings-kid">
          <input type="text" value="${escapeHtml(kid.name)}" onchange="renameKid(${i}, this.value)" placeholder="Name">
          <input type="password" class="settings-pin-input"
                 maxlength="4" inputmode="numeric" pattern="[0-9]*"
                 placeholder="${isPinHash(kid.pin) ? '••••' : 'Set PIN'}"
                 onchange="setKidPin(${i}, this.value)">
          ${state.kids.length > 1 ? `
            <button class="remove-kid" onclick="confirmRemoveKid(${i})">✕</button>
          ` : ''}
        </div>
      `).join('')}
      <button class="add-kid-btn" onclick="addKid()">+ Add Another Kid</button>
    </div>

    <div class="settings-section">
      <label class="settings-section-label">Kid Mode</label>
      <p class="settings-about" style="margin-bottom:12px">
        Lock the app so kids can only see their own data. Each kid needs a 4-digit PIN above.
      </p>
      <div class="form-group" style="margin-bottom:12px">
        <label>Parent PIN (to unlock full access)</label>
        <div class="pin-input-wrapper">
          <input type="password" id="parentPinInput" class="settings-pin-input parent-pin"
                 maxlength="4" inputmode="numeric" pattern="[0-9]*"
                 placeholder="${isPinHash(state.parentPin) ? '••••' : 'Set PIN'}"
                 onchange="setParentPin(this.value)">
        </div>
      </div>
      <div class="settings-toggle-row">
        <span>Enable Kid Mode</span>
        <button class="toggle-switch ${kidModeEnabled ? 'active' : ''}"
                onclick="toggleKidMode()">
          <span class="toggle-knob"></span>
        </button>
      </div>
    </div>

    <div class="settings-section">
      <label class="settings-section-label">Default Sales Tax State</label>
      <div class="form-group" style="margin-bottom:0">
        <select id="settingsState" onchange="updateDefaultState(this.value)">
          ${stateOptions}
        </select>
      </div>
    </div>

    <div class="settings-section">
      <label class="settings-section-label">Payment Links</label>
      <p class="settings-about" style="margin-bottom:12px">
        Let family and friends know where to send gift contributions.
        These will be visible to anyone who has a wishlist share link — use a username, not an email.
        For Apple Cash, a phone number or Apple ID email is required.
      </p>
      <div class="form-group" style="margin-bottom:10px">
        <label>PayPal.me username</label>
        <div class="payment-handle-row">
          <span class="payment-handle-prefix">paypal.me/</span>
          <input type="text" class="payment-handle-input"
                 value="${escapeHtml(state.paypalMe || '')}"
                 maxlength="30" placeholder="yourname"
                 onchange="setPaymentHandle('paypalMe', this.value)">
        </div>
      </div>
      <div class="form-group" style="margin-bottom:10px">
        <label>Venmo handle</label>
        <div class="payment-handle-row">
          <span class="payment-handle-prefix">@</span>
          <input type="text" class="payment-handle-input"
                 value="${escapeHtml(state.venmoHandle || '')}"
                 maxlength="30" placeholder="yourname"
                 onchange="setPaymentHandle('venmoHandle', this.value)">
        </div>
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label>Apple Cash (phone or Apple ID email)</label>
        <input type="text" class="payment-handle-input" style="border:1.5px solid var(--border);border-radius:var(--radius-xs);padding:9px 12px;width:100%;box-sizing:border-box"
               value="${escapeHtml(state.appleCash || '')}"
               maxlength="50" placeholder="+1 (555) 000-0000 or you@icloud.com"
               onchange="setAppleCash(this.value)">
      </div>
    </div>

    <div class="settings-section">
      <label class="settings-section-label">Family Access</label>
      ${!ownerFamilyId ? `
        <p class="settings-about" style="margin-bottom:12px">
          Invite grandparents, aunts, uncles, and other family to view wishlists and suggest chores — without sharing your account.
        </p>
        <button class="submit-btn" style="background:var(--purple);width:100%" onclick="createFamily()">Set Up Family Access</button>
      ` : `
        <p class="settings-about" style="margin-bottom:12px">
          Share this invite link. Family members sign up for their own account and get a scoped view of the kids' wishlists and chore board.
        </p>
        <button id="copyInviteBtn" class="submit-btn" style="background:var(--purple);width:100%;margin-bottom:8px" onclick="generateFamilyInvite()">Copy Invite Link</button>
        ${ownerFamilyMembers.length > 0 ? `
          <div class="family-members-list">
            <div class="family-members-label">${ownerFamilyMembers.length} member${ownerFamilyMembers.length === 1 ? '' : 's'}</div>
            ${ownerFamilyMembers.map(m => `
              <div class="family-member-row">
                <div class="family-member-info">
                  <div class="family-member-name">${escapeHtml(m.displayName || m.email)}</div>
                  <div class="family-member-email">${escapeHtml(m.email)}</div>
                </div>
                <button class="family-member-remove" onclick="removeFamilyMember('${sanitizeId(m.uid)}')">Remove</button>
              </div>
            `).join('')}
          </div>
        ` : `<p class="settings-about">No members yet — share the invite link above.</p>`}
      `}
    </div>

    <div class="settings-section">
      <label class="settings-section-label">About</label>
      <p class="settings-about">KidCash helps families track kids' money without needing a bank account. Your data syncs securely across all your devices.</p>
    </div>

    <div class="settings-section">
      <label class="settings-section-label">Account</label>
      <p class="settings-user-email">Signed in as ${escapeHtml(currentUser?.email || 'Unknown')}</p>
      ${currentUser?.email && !currentUser?.emailVerified && currentUser?.providerData?.[0]?.providerId === 'password'
        ? `<div class="email-verify-warning">${svgIcon(SVG.warning, 16)} Email not verified. <button onclick="handleResendVerification()">Resend verification email</button></div>`
        : ''}
      <button class="signout-btn" onclick="handleSignOut()">Sign Out</button>
    </div>
  `;
}

// ─── Reusable Card Components ────────────────────────────────
function getGoalContributions(goal) {
  if (!goal.wishlistItemId) return { total: 0, list: [] };
  const kid = getActiveKid();
  const claimDoc = (wishlistClaimsCache[kid?.id] || {})[goal.wishlistItemId];
  const list = claimDoc?.contributions || [];
  const total = list.reduce((sum, c) => sum + c.amount, 0);
  return { total, list };
}

function renderGoalCard(goal, balance) {
  const tax = calcTax(goal.target, selectedState);
  const effectiveTarget = goal.target + tax;
  const { total: contributed, list: contribList } = getGoalContributions(goal);
  const totalProgress = balance + contributed;
  const percent = effectiveTarget > 0 ? Math.min(100, Math.round((totalProgress / effectiveTarget) * 100)) : 0;
  const isComplete = percent >= 100;
  const remaining = totalProgress - effectiveTarget;
  return `
    <div class="goal-card">
      <div class="goal-card-inner">
        ${progressRing(percent, 60)}
        <div class="goal-card-text">
          <div class="goal-name">${escapeHtml(goal.name)}</div>
          <div class="goal-amount">${formatMoney(balance)} saved${contributed > 0 ? ` + ${formatMoney(contributed)} gifted` : ''} / ${formatMoney(effectiveTarget)}</div>
          ${tax > 0 ? `<div class="goal-tax-note">Includes ${formatMoney(tax)} tax (${STATE_TAX_RATES[selectedState]?.rate}%)</div>` : ''}
          <div class="goal-percent">${isComplete ? '🎉 Goal reached!' : `${percent}% there`}</div>
          <div class="goal-balance-after ${remaining < 0 ? 'negative' : ''}">
            ${isComplete ? `${formatMoney(remaining)} left after buying` : `Need ${formatMoney(Math.abs(remaining))} more`}
          </div>
          ${contribList.length > 0 ? `
            <div class="goal-contrib-list">
              ${contribList.map(c => `<span class="goal-contrib-chip">🎁 ${escapeHtml(c.name)} · ${formatMoney(c.amount)}</span>`).join('')}
            </div>
          ` : ''}
        </div>
      </div>
      <div class="goal-actions">
        ${isComplete ? `<button class="goal-action-btn buy" onclick="goalToPurchase('${sanitizeId(goal.id)}')">🎉 Buy it now</button>` : ''}
        <button class="goal-action-btn wishlist" onclick="goalToWishlist('${sanitizeId(goal.id)}')">← Wishlist</button>
        <button class="goal-action-btn delete" onclick="confirmDeleteGoal('${sanitizeId(goal.id)}')">Remove</button>
      </div>
    </div>
  `;
}

function renderTransaction(t) {
  const icon = getCategoryIcon(t.type, t.category);
  const taxInfo = t.tax ? `<span class="tx-tax">incl. ${formatMoney(t.tax)} tax (${escapeHtml(t.taxState || '')})</span>` : '';
  const createdByBadge = t.createdBy ? `<span class="tx-created-by tx-created-by--${t.createdBy}">${t.createdBy === 'kid' ? 'Kid' : 'Parent'}</span>` : '';
  return `
    <div class="transaction-item">
      <div class="tx-icon ${t.type}">${icon}</div>
      <div class="tx-details">
        <div class="tx-description">${escapeHtml(t.description)}</div>
        <div class="tx-date">${formatDate(t.timestamp)}${taxInfo}${createdByBadge}</div>
      </div>
      <div class="tx-amount ${t.type}">${t.type === 'income' ? '+' : '-'}${formatMoney(t.amount)}</div>
      ${isInKidMode() ? '' : `<button class="tx-delete" onclick="confirmDeleteTransaction('${sanitizeId(t.id)}')" title="Delete">✕</button>`}
    </div>
  `;
}

function renderWishlistCard(item, balance, claim) {
  const hasImage = item.image;
  const tax = calcTax(item.price, selectedState);
  const totalWithTax = item.price + tax;
  const remaining = (balance != null) ? balance - totalWithTax : null;
  const isClaimed = !!(claim?.claimedBy);
  const contributions = claim?.contributions || [];
  const totalContributed = contributions.reduce((sum, c) => sum + c.amount, 0);
  const contribPercent = item.price > 0 ? Math.min(100, Math.round((totalContributed / item.price) * 100)) : 0;
  const effectiveRemaining = remaining != null ? remaining + totalContributed : null;

  return `
    <div class="wishlist-card ${isClaimed ? 'wishlist-card--claimed' : contributions.length > 0 ? 'wishlist-card--contributed' : ''}">
      ${isClaimed ? `
        <div class="wishlist-gift-banner">
          <span class="wishlist-gift-icon">🎁</span>
          <span><strong>${escapeHtml(claim.claimedBy)}</strong> is getting this for you!</span>
        </div>
      ` : contributions.length > 0 ? `
        <div class="wishlist-contrib-section">
          <div class="wishlist-contrib-bar-wrap">
            <div class="wishlist-contrib-bar-fill" style="width:${contribPercent}%"></div>
          </div>
          <div class="wishlist-contrib-meta">
            <span class="wishlist-contrib-total">${formatMoney(totalContributed)} of ${formatMoney(item.price)} contributed</span>
          </div>
          <div class="wishlist-contrib-chips">
            ${contributions.map(c => `<span class="wishlist-contrib-chip">🎁 ${escapeHtml(c.name)} · ${formatMoney(c.amount)}</span>`).join('')}
          </div>
        </div>
      ` : ''}
      <div class="wishlist-top">
        ${hasImage ? `<img class="wishlist-image" src="${escapeHtml(item.image)}" alt="" onerror="this.style.display='none'">` : ''}
        <div class="wishlist-info">
          <div class="wishlist-name">${escapeHtml(item.name)}</div>
          <div class="wishlist-price">${formatMoney(item.price)}${tax > 0 ? ` <span class="wishlist-price-withtax">~${formatMoney(totalWithTax)} with tax</span>` : ''}</div>
          ${!isClaimed && effectiveRemaining != null ? `
            <div class="wishlist-balance-after ${effectiveRemaining < 0 ? 'negative' : ''}">
              ${effectiveRemaining >= 0 ? `${formatMoney(effectiveRemaining)} left after` : `Need ${formatMoney(Math.abs(effectiveRemaining))} more`}
              ${totalContributed > 0 ? `<span class="wishlist-contrib-note"> (incl. ${formatMoney(totalContributed)} contributed)</span>` : ''}
            </div>
          ` : ''}
          ${buildProductUrl(item.url) ? `<a class="wishlist-view-btn" href="${buildProductUrl(item.url)}" target="_blank" rel="noopener noreferrer">${svgIcon('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>', 13)} View product</a>` : ''}
        </div>
      </div>
      <div class="wishlist-actions">
        ${isClaimed ? `
          <button class="wishlist-action-btn delete" onclick="confirmDeleteWishlistItem('${sanitizeId(item.id)}')">Remove</button>
        ` : `
          <button class="wishlist-action-btn goal primary" onclick="wishlistToGoal('${sanitizeId(item.id)}')">Set as Goal</button>
          <button class="wishlist-action-btn buy" onclick="wishlistToPurchase('${sanitizeId(item.id)}')">Buy</button>
          <button class="wishlist-action-btn delete" onclick="confirmDeleteWishlistItem('${sanitizeId(item.id)}')">Remove</button>
        `}
      </div>
    </div>
  `;
}

// ─── Modals ──────────────────────────────────────────────────
function renderModal() {
  if (modalOpen === 'transaction') return renderTransactionModal();
  if (modalOpen === 'wishlist') return renderWishlistModal();
  if (modalOpen === 'wishlist-share') return renderWishlistShareModal();
  if (modalOpen === 'choreShare') return renderChoreShareModal();
  if (modalOpen === 'recurring') return renderRecurringModal();
  if (modalOpen === 'chore') return renderChoreModal();
  if (modalOpen === 'template') return renderTemplateModal();
  return '';
}

function renderTemplateModal() {
  const t = editingTemplateId ? getChoreTemplates().find(t => t.id === editingTemplateId) : null;
  return `
    <div class="modal-overlay open" onclick="handleOverlayClick(event)">
      <div class="modal">
        <div class="modal-handle"></div>
        <h2>${t ? 'Edit Template' : 'New Template'}</h2>
        <div class="form-group">
          <label>Chore name</label>
          <input type="text" id="templateName" placeholder="e.g., Take out trash" value="${t ? escapeHtml(t.name) : ''}">
        </div>
        <div class="form-group">
          <label>Suggested payment</label>
          <input type="number" id="templateAmount" placeholder="0.00" step="0.01" min="0.01" inputmode="decimal" value="${t ? (t.amount / 100).toFixed(2) : ''}">
        </div>
        <div class="form-group">
          <label>Permissions</label>
          <div class="toggle-row">
            <label class="toggle-label">
              <input type="checkbox" id="templateKidCanAdd" ${t && t.kidCanAdd ? 'checked' : ''}>
              <span class="toggle-text">
                <strong>🧒 Kids can self-add</strong>
                <small>Kids can add this chore to their own list — still needs approval when done</small>
              </span>
            </label>
          </div>
          <div class="toggle-row">
            <label class="toggle-label">
              <input type="checkbox" id="templateAutoApprove" ${t && t.autoApprove ? 'checked' : ''}>
              <span class="toggle-text">
                <strong>⚡ Auto-approve</strong>
                <small>Credit is applied immediately when kid marks it done — no parent review needed</small>
              </span>
            </label>
          </div>
        </div>
        <button class="submit-btn green" onclick="submitTemplate()">${t ? 'Save Changes' : 'Add Template'}</button>
      </div>
    </div>
  `;
}

function renderChoreModal() {
  const editing = editingChoreId !== null;
  const editChore = editing ? (state.chores || []).find(c => c.id === editingChoreId) : null;
  const prefillKidId = editChore ? editChore.kidId : (chorePrefill.kidId || '');
  const prefillName = editChore ? editChore.name : chorePrefill.name;
  const prefillAmount = editChore ? editChore.amount : chorePrefill.amount;
  const prefillRepeating = editChore ? editChore.repeating : choreRepeating;
  return `
    <div class="modal-overlay open" onclick="handleOverlayClick(event)">
      <div class="modal">
        <div class="modal-handle"></div>
        <h2>${editing ? 'Edit Chore' : 'Add Chore'}</h2>
        <div class="form-group">
          <label>For</label>
          <select id="choreKid">
            ${state.kids.map(k => `<option value="${escapeHtml(k.id)}" ${k.id === prefillKidId ? 'selected' : ''}>${escapeHtml(k.name)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Chore</label>
          <input type="text" id="choreName" placeholder="e.g., Take out trash" value="${escapeHtml(prefillName)}">
        </div>
        <div class="form-group">
          <label>Payment</label>
          <input type="number" id="choreAmount" placeholder="0.00" step="0.01" min="0.01" inputmode="decimal" value="${prefillAmount ? (prefillAmount / 100).toFixed(2) : ''}">
        </div>
        <div class="settings-toggle-row" style="margin-bottom:16px">
          <span>Repeating (resets after approval)</span>
          <button class="toggle-switch ${prefillRepeating ? 'active' : ''}" id="choreRepeatingToggle" onclick="toggleChoreRepeating()">
            <span class="toggle-knob"></span>
          </button>
        </div>
        <button class="submit-btn green" onclick="submitChore()">${editing ? 'Save Changes' : 'Add Chore'}</button>
      </div>
    </div>
  `;
}

function renderRecurringModal() {
  const editing = editingRecurringId !== null;
  const er = editing ? (state.recurringActivities || []).find(r => r.id === editingRecurringId) : null;
  const activeType = er ? er.type : recurringType;
  return `
    <div class="modal-overlay open" onclick="handleOverlayClick(event)">
      <div class="modal">
        <div class="modal-handle"></div>
        <h2>${editing ? 'Edit Recurring' : 'Add Recurring Activity'}</h2>
        <div class="form-group">
          <label>For</label>
          <select id="recurringKid">
            ${state.kids.map(k => `<option value="${escapeHtml(k.id)}" ${er && k.id === er.kidId ? 'selected' : ''}>${escapeHtml(k.name)}</option>`).join('')}
          </select>
        </div>
        <div class="type-toggle">
          <button id="recurringTypeIncome" class="${activeType === 'income' ? 'active-income' : ''}" onclick="setRecurringType('income')">Add Money</button>
          <button id="recurringTypeExpense" class="${activeType === 'expense' ? 'active-expense' : ''}" onclick="setRecurringType('expense')">Spending</button>
        </div>
        <div class="form-group">
          <label>Amount</label>
          <input type="number" id="recurringAmount" placeholder="0.00" step="0.01" min="0.01" inputmode="decimal" value="${er ? (er.amount / 100).toFixed(2) : ''}">
        </div>
        <div class="form-group">
          <label>Description</label>
          <input type="text" id="recurringDescription" placeholder="e.g., Weekly allowance" value="${er ? escapeHtml(er.description) : ''}">
        </div>
        <div class="form-group">
          <label>Category</label>
          <select id="recurringCategory">
            ${CATEGORIES[activeType].map(c => `<option value="${c.value}" ${er && c.value === er.category ? 'selected' : ''}>${c.icon} ${c.label}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Frequency</label>
          <select id="recurringFrequency">
            <option value="weekly" ${er && er.frequency === 'weekly' ? 'selected' : ''}>Weekly</option>
            <option value="biweekly" ${er && er.frequency === 'biweekly' ? 'selected' : ''}>Every 2 weeks</option>
            <option value="monthly" ${er && er.frequency === 'monthly' ? 'selected' : ''}>Monthly</option>
          </select>
        </div>
        <button class="submit-btn ${activeType === 'income' ? 'green' : ''}" id="recurringSubmitBtn" style="${activeType === 'expense' ? 'background:var(--red)' : ''}" onclick="submitRecurringActivity()">${editing ? 'Save Changes' : 'Add Recurring Activity'}</button>
      </div>
    </div>
  `;
}

function renderTransactionModal() {
  const categories = CATEGORIES[txType];
  const stateOptions = Object.entries(STATE_TAX_RATES).map(([code, info]) => {
    const rateLabel = code === '' ? '' : (info.rate === 0 ? ' (no tax)' : ` (${info.rate}%)`);
    return `<option value="${code}" ${code === selectedState ? 'selected' : ''}>${code === '' ? '-- No sales tax --' : info.name}${rateLabel}</option>`;
  }).join('');

  return `
    <div class="modal-overlay open" onclick="handleOverlayClick(event)">
      <div class="modal">
        <div class="modal-handle"></div>
        <h2>${txType === 'income' ? 'Add Money' : 'Record Spending'}</h2>
        ${isInKidMode() ? '' : `<div class="type-toggle">
          <button class="${txType === 'income' ? 'active-income' : ''}" onclick="setTxType('income')">💵 Add Money</button>
          <button class="${txType === 'expense' ? 'active-expense' : ''}" onclick="setTxType('expense')">🛒 Spending</button>
        </div>`}
        <div class="form-group">
          <label>${txType === 'expense' ? 'Price (before tax)' : 'Amount'}</label>
          <input type="number" id="txAmount" placeholder="0.00" step="0.01" min="0.01" inputmode="decimal" oninput="updateTaxPreview()">
        </div>
        ${txType === 'expense' ? `
          <div class="form-group">
            <label>Sales Tax State</label>
            <select id="txState" onchange="updateTaxPreview()">
              ${stateOptions}
            </select>
          </div>
          <div id="taxPreview" class="tax-preview" style="display:none">
            <div class="tax-row"><span>Subtotal</span><span id="taxSubtotal">$0.00</span></div>
            <div class="tax-row"><span>Tax (<span id="taxRateLabel">0%</span>)</span><span id="taxAmount">$0.00</span></div>
            <div class="tax-row tax-total"><span>Total</span><span id="taxTotal">$0.00</span></div>
          </div>
          <div id="balanceAfterPreview" class="balance-after-preview" style="display:none">
            <span>Balance after purchase</span><span id="balanceAfter" class="balance-after-amount">$0.00</span>
          </div>
        ` : ''}
        <div class="form-group">
          <label>Description</label>
          <input type="text" id="txDescription" placeholder="${txType === 'income' ? 'e.g., Birthday money from Grandma' : 'e.g., New toy from Target'}">
        </div>
        <div class="form-group">
          <label>Category</label>
          <select id="txCategory">
            ${categories.map(c => `<option value="${c.value}">${c.icon} ${c.label}</option>`).join('')}
          </select>
        </div>
        <button class="submit-btn ${txType === 'income' ? 'green' : ''}" onclick="submitTransaction()" style="${txType === 'expense' ? 'background:var(--red)' : ''}">
          ${txType === 'income' ? 'Add Money' : 'Record Spending'}
        </button>
      </div>
    </div>
  `;
}


function renderWishlistModal() {
  const statusHtml = fetchStatus === 'loading'
    ? '<div class="fetch-status loading">Fetching product info...</div>'
    : fetchStatus === 'error'
    ? '<div class="fetch-status error">Could not auto-fetch. Enter details manually.</div>'
    : fetchStatus === 'done'
    ? '<div class="fetch-status success">Product info found!</div>'
    : '';

  const imagePreview = fetchedProduct.image
    ? `<img class="fetch-image-preview" src="${escapeHtml(fetchedProduct.image)}" alt="" onerror="this.style.display='none'">`
    : '';

  return `
    <div class="modal-overlay open" onclick="handleOverlayClick(event)">
      <div class="modal">
        <div class="modal-handle"></div>
        <h2>Add to Wishlist</h2>
        <div class="form-group">
          <label>Product URL <span class="label-optional">(optional)</span></label>
          <div class="url-input-group">
            <input type="url" id="wishlistUrl" placeholder="Paste a link to auto-fill..." inputmode="url">
            <button class="fetch-btn" onclick="doFetchProduct()" ${fetchStatus === 'loading' ? 'disabled' : ''}>
              ${fetchStatus === 'loading' ? '...' : 'Fetch'}
            </button>
          </div>
        </div>
        ${statusHtml}
        ${imagePreview}
        <div class="form-group">
          <label>Name</label>
          <input type="text" id="wishlistName" placeholder="e.g., LEGO Star Wars Set" value="${escapeHtml(fetchedProduct.name)}">
        </div>
        <div class="form-group">
          <label>Price</label>
          <input type="number" id="wishlistPrice" placeholder="0.00" step="0.01" min="0.01" inputmode="decimal" ${fetchedProduct.price ? `value="${fetchedProduct.price}"` : ''}>
        </div>
        <button class="submit-btn" onclick="submitWishlistItem()" style="background:var(--purple)">Add to Wishlist</button>
      </div>
    </div>
  `;
}

function renderWishlistClaimsSection(kidId) {
  const wishlist = getKidWishlist(kidId);
  if (wishlist.length === 0) return '';

  if (wishlistShareClaims === null) {
    return `<div class="claims-section"><p class="claims-loading">Loading gift claims…</p></div>`;
  }

  const claimed = wishlist.filter(w => wishlistShareClaims[w.id]);
  const unclaimed = wishlist.filter(w => !wishlistShareClaims[w.id]);

  return `
    <div class="claims-section">
      <div class="claims-header">
        <span class="claims-title">Gift Status</span>
        <button class="claims-refresh-btn" onclick="refreshWishlistClaims()">↻ Refresh</button>
      </div>
      ${claimed.length === 0 && unclaimed.length > 0 ? `
        <p class="claims-empty">No one has claimed anything yet.</p>
      ` : ''}
      ${claimed.map(w => `
        <div class="claim-row claimed">
          <div class="claim-row-name">${escapeHtml(w.name)}</div>
          <div class="claim-row-by">🎁 ${escapeHtml(wishlistShareClaims[w.id].claimedBy)}</div>
        </div>
      `).join('')}
      ${unclaimed.map(w => `
        <div class="claim-row">
          <div class="claim-row-name">${escapeHtml(w.name)}</div>
          <div class="claim-row-status">Not claimed</div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderWishlistShareModal() {
  const kidId = shareModalKidId;
  const kid = state.kids.find(k => k.id === kidId);
  if (!kid) return '';
  const token = (state.wishlistShares || {})[kidId];
  const isShared = !!token;
  const shareUrl = isShared ? `${new URL('wishlist.html', window.location.href).href.split('?')[0]}?id=${token}` : '';
  return `
    <div class="modal-overlay open" onclick="handleOverlayClick(event)">
      <div class="modal">
        <div class="modal-handle"></div>
        <h2>Share Wishlist</h2>
        ${isShared ? `
          <p class="share-modal-desc">Anyone with this link can see ${escapeHtml(kid.name)}'s wishlist and mark what they're buying — no login needed.</p>
          <div class="share-url-box">${escapeHtml(shareUrl)}</div>
          <button id="copyShareBtn" class="submit-btn" style="background:var(--purple)" onclick="copyShareLink('${escapeHtml(shareUrl)}')">Copy Link</button>
          <button class="share-stop-btn" onclick="revokeWishlistShare('${sanitizeId(kidId)}')">Stop Sharing</button>
        ` : `
          <p class="share-modal-desc">Create a shareable link so family and friends can see ${escapeHtml(kid.name)}'s wishlist. No login needed — perfect for birthdays and holidays!</p>
          <button class="submit-btn" style="background:var(--purple)" onclick="shareWishlist('${sanitizeId(kidId)}')">Create Share Link</button>
        `}
      </div>
    </div>
  `;
}

function renderChoreShareModal() {
  const kidId = choreShareModalKidId;
  const kid = state.kids.find(k => k.id === kidId);
  if (!kid) return '';
  const token = (state.choreShares || {})[kidId];
  const shareUrl = token
    ? new URL('choreboard.html', window.location.href).href.split('?')[0] + '?id=' + token
    : null;
  return `
    <div class="modal-overlay open" onclick="handleOverlayClick(event)">
      <div class="modal">
        <div class="modal-handle"></div>
        <h2>Family Chore Board</h2>
        <p class="share-modal-desc">
          Share this link with family and friends. They can suggest chores and set reward amounts for ${escapeHtml(kid.name)}.
          You'll review and approve each one before it appears to ${escapeHtml(kid.name)}.
        </p>
        ${token && shareUrl ? `
          <div class="share-url-box">${escapeHtml(shareUrl)}</div>
          <div style="display:flex;gap:8px;margin-bottom:12px">
            <button id="copyChoreLinkBtn" class="submit-btn" style="flex:1;background:var(--purple)" onclick="copyChoreLink('${escapeHtml(shareUrl)}')">Copy Link</button>
            <a class="share-view-btn" href="${escapeHtml(shareUrl)}" target="_blank" rel="noopener noreferrer">Preview</a>
          </div>
          <button class="share-stop-btn" onclick="revokeChoreBoard('${sanitizeId(kidId)}')">Stop Sharing</button>
        ` : `
          <button class="submit-btn" style="background:var(--purple);width:100%" onclick="shareChoreBoard('${sanitizeId(kidId)}')">Create Share Link</button>
        `}
      </div>
    </div>
  `;
}

function renderConfirm() {
  if (!confirmAction) return '';
  return `
    <div class="confirm-overlay" onclick="cancelConfirm()">
      <div class="confirm-box" onclick="event.stopPropagation()">
        <p>${confirmAction.message}</p>
        <div class="confirm-actions">
          <button class="confirm-cancel" onclick="cancelConfirm()">Cancel</button>
          <button class="confirm-delete" onclick="executeConfirm()">${confirmAction.label || 'Delete'}</button>
        </div>
      </div>
    </div>
  `;
}

function renderParentUnlockModal() {
  if (!showParentUnlockModal) return '';
  return `
    <div class="confirm-overlay" onclick="cancelParentUnlock()">
      <div class="confirm-box parent-unlock-box" onclick="event.stopPropagation()">
        <h3 style="text-align:center; margin:0 0 16px 0; font-size:18px;">🔒 Parent Mode</h3>
        ${parentUnlockError ? `<div class="auth-error" style="margin-bottom:12px">${escapeHtml(parentUnlockError)}</div>` : ''}
        <div class="form-group" style="margin-bottom:16px">
          <label>Parent PIN</label>
          <input type="password" id="parentUnlockPin" placeholder="Enter 4-digit PIN"
                 maxlength="4" inputmode="numeric" pattern="[0-9]*"
                 class="login-input" style="margin-bottom:0; text-align:center; letter-spacing:8px; font-size:20px;" autocomplete="off">
        </div>
        <div style="display:flex; gap:10px;">
          <button class="confirm-cancel" onclick="cancelParentUnlock()" style="flex:1; padding:12px; border-radius:12px; border:none; font-size:14px; font-weight:600; cursor:pointer; background:var(--bg); color:var(--text);">Cancel</button>
          <button class="submit-btn" onclick="attemptParentUnlock()" style="flex:1; margin-top:0;" ${parentUnlockBusy ? 'disabled' : ''}>
            ${parentUnlockBusy ? 'Checking...' : 'Unlock'}
          </button>
        </div>
      </div>
    </div>
  `;
}

// ─── Event Handlers ───────────────────────────────────────────
function bindEvents() {
  if (modalOpen === 'transaction') {
    setTimeout(() => {
      const el = document.getElementById('txAmount');
      if (el) el.focus();
    }, 100);
  }
  if (modalOpen === 'wishlist') {
    setTimeout(() => {
      const el = document.getElementById('wishlistUrl');
      if (el) el.focus();
    }, 100);
  }
  if (modalOpen === 'recurring') {
    setTimeout(() => {
      const el = document.getElementById('recurringAmount');
      if (el) el.focus();
    }, 100);
  }
  if (modalOpen === 'chore') {
    setTimeout(() => {
      const el = document.getElementById('choreName');
      if (el) el.focus();
    }, 100);
  }
  if (modalOpen === 'transaction' && pendingWishlistPurchase && txType === 'expense') {
    setTimeout(() => {
      const amtEl = document.getElementById('txAmount');
      const descEl = document.getElementById('txDescription');
      if (amtEl && !amtEl.value) amtEl.value = (pendingWishlistPurchase.price / 100).toFixed(2);
      if (descEl && !descEl.value) descEl.value = pendingWishlistPurchase.name;
      updateTaxPreview();
    }, 100);
  }
}

window.switchKid = function(index) {
  if (isInKidMode()) return; // blocked in kid mode
  state.activeKidIndex = index;
  pendingWishlistPurchase = null;
  activityTab = 'history';
  saveData(state);
  render();
};

window.setActivityTab = function(tab) {
  activityTab = tab;
  render();
};

window.openTransactionModal = function(type) {
  txType = isInKidMode() ? 'expense' : type; // kids can only record spending
  modalOpen = 'transaction';
  render();
};

window.openModal = function(type) {
  modalOpen = type;
  if (type === 'recurring') { recurringType = 'income'; editingRecurringId = null; }
  if (type === 'chore') { choreRepeating = false; chorePrefill = { name: '', amount: '' }; editingChoreId = null; }
  render();
};

window.closeModal = function() {
  modalOpen = null;
  pendingWishlistPurchase = null;
  editingChoreId = null;
  editingRecurringId = null;
  editingTemplateId = null;
  render();
};

window.handleOverlayClick = function(e) {
  if (e.target.classList.contains('modal-overlay')) {
    closeModal();
  }
};

window.setTxType = function(type) {
  txType = type;
  render();
};

window.updateTaxPreview = function() {
  if (txType !== 'expense') return;
  const amountStr = document.getElementById('txAmount')?.value;
  const stateCode = document.getElementById('txState')?.value || '';
  const preview = document.getElementById('taxPreview');
  const balPreview = document.getElementById('balanceAfterPreview');
  if (!preview) return;
  const amountCents = parseMoney(amountStr);
  const info = STATE_TAX_RATES[stateCode];

  // Show/hide tax breakdown
  if (!amountCents || !stateCode || !info || info.rate === 0) {
    preview.style.display = 'none';
  } else {
    const taxCents = calcTax(amountCents, stateCode);
    const totalCents = amountCents + taxCents;
    document.getElementById('taxSubtotal').textContent = formatMoney(amountCents);
    document.getElementById('taxRateLabel').textContent = info.rate + '%';
    document.getElementById('taxAmount').textContent = formatMoney(taxCents);
    document.getElementById('taxTotal').textContent = formatMoney(totalCents);
    preview.style.display = 'block';
  }

  // Always show balance-after when there's an amount
  if (balPreview && amountCents) {
    const kid = getActiveKid();
    const balance = kid ? getBalance(kid.id) : 0;
    const taxCents = (stateCode && info && info.rate > 0) ? calcTax(amountCents, stateCode) : 0;
    const totalSpend = amountCents + taxCents;
    const remaining = balance - totalSpend;
    const balEl = document.getElementById('balanceAfter');
    balEl.textContent = formatMoney(remaining);
    balEl.className = 'balance-after-amount' + (remaining < 0 ? ' negative' : '');
    balPreview.style.display = 'flex';
  } else if (balPreview) {
    balPreview.style.display = 'none';
  }
};

window.submitTransaction = function() {
  const subtotal = parseMoney(document.getElementById('txAmount').value);
  const description = document.getElementById('txDescription').value.trim();
  const category = document.getElementById('txCategory').value;
  const kid = getActiveKid();
  if (!subtotal) { shakeElement('txAmount'); return; }
  let taxCents = 0;
  let taxState = '';
  let taxRate = 0;
  if (txType === 'expense') {
    const stateEl = document.getElementById('txState');
    taxState = stateEl ? stateEl.value : '';
    if (taxState) {
      selectedState = taxState;
      localStorage.setItem('kidcash_state', taxState);
      const info = STATE_TAX_RATES[taxState];
      if (info && info.rate > 0) {
        taxRate = info.rate;
        taxCents = calcTax(subtotal, taxState);
      }
    }
  }
  const totalAmount = txType === 'expense' ? subtotal + taxCents : subtotal;
  state.transactions.push({
    id: generateId(),
    kidId: kid.id,
    type: txType,
    amount: totalAmount,
    subtotal: txType === 'expense' ? subtotal : undefined,
    tax: taxCents || undefined,
    taxRate: taxRate || undefined,
    taxState: taxState || undefined,
    description: description || (txType === 'income' ? 'Added money' : 'Purchase'),
    category,
    timestamp: Date.now(),
    createdBy: isInKidMode() ? 'kid' : 'parent',
  });
  saveData(state);
  modalOpen = null;
  render();
};


window.openAddTemplateModal = function() {
  editingTemplateId = null;
  modalOpen = 'template';
  render();
  setTimeout(() => { const el = document.getElementById('templateName'); if (el) el.focus(); }, 100);
};

window.openEditTemplateModal = function(id) {
  editingTemplateId = id;
  modalOpen = 'template';
  render();
};

window.submitTemplate = function() {
  const name = document.getElementById('templateName').value.trim();
  const amount = parseMoney(document.getElementById('templateAmount').value);
  const kidCanAdd = document.getElementById('templateKidCanAdd').checked;
  const autoApprove = document.getElementById('templateAutoApprove').checked;
  if (!name) { shakeElement('templateName'); return; }
  if (!amount) { shakeElement('templateAmount'); return; }
  if (!state.choreTemplates) state.choreTemplates = getChoreTemplates();
  const templates = state.choreTemplates;
  if (editingTemplateId) {
    const t = templates.find(t => t.id === editingTemplateId);
    if (t) { t.name = name; t.amount = amount; t.kidCanAdd = kidCanAdd; t.autoApprove = autoApprove; }
    editingTemplateId = null;
  } else {
    templates.push({ id: generateId(), name, amount, kidCanAdd, autoApprove });
  }
  state.choreTemplates = templates;
  saveData(state);
  modalOpen = null;
  render();
};

window.toggleTemplateFlag = function(id, flag) {
  if (!state.choreTemplates) state.choreTemplates = getChoreTemplates();
  const t = state.choreTemplates.find(t => t.id === id);
  if (!t) return;
  t[flag] = !t[flag];
  saveData(state);
  render();
};

window.confirmDeleteTemplate = function(id) {
  confirmAction = {
    message: 'Remove this template from Quick Add?',
    action: () => {
      if (!state.choreTemplates) state.choreTemplates = getChoreTemplates();
      state.choreTemplates = state.choreTemplates.filter(t => t.id !== id);
      saveData(state);
    },
  };
  render();
};

window.openChoreModalWithSuggestion = function(name, amount) {
  choreRepeating = false;
  chorePrefill = { name, amount };
  modalOpen = 'chore';
  render();
};

window.toggleChoreRepeating = function() {
  choreRepeating = !choreRepeating;
  const btn = document.getElementById('choreRepeatingToggle');
  if (btn) btn.className = `toggle-switch ${choreRepeating ? 'active' : ''}`;
};

window.submitChore = function() {
  const kidId = document.getElementById('choreKid').value;
  const name = document.getElementById('choreName').value.trim();
  const amount = parseMoney(document.getElementById('choreAmount').value);
  if (!name) { shakeElement('choreName'); return; }
  if (!amount) { shakeElement('choreAmount'); return; }
  if (!state.chores) state.chores = [];
  if (editingChoreId) {
    const chore = state.chores.find(c => c.id === editingChoreId);
    if (chore) {
      chore.kidId = kidId;
      chore.name = name;
      chore.amount = amount;
      chore.repeating = choreRepeating;
    }
    editingChoreId = null;
  } else {
    state.chores.push({
      id: generateId(),
      kidId,
      name,
      amount,
      repeating: choreRepeating,
      status: 'available',
      createdAt: Date.now(),
    });
  }
  saveData(state);
  modalOpen = null;
  render();
};

window.openEditChoreModal = function(id) {
  const chore = (state.chores || []).find(c => c.id === id);
  if (!chore) return;
  editingChoreId = id;
  choreRepeating = chore.repeating || false;
  chorePrefill = { name: '', amount: '' };
  modalOpen = 'chore';
  render();
};

window.skipChore = function(id) {
  const chore = (state.chores || []).find(c => c.id === id);
  if (!chore) return;
  confirmAction = {
    message: `Skip "${escapeHtml(chore.name)}"? You won't get paid for it.`,
    label: 'Skip it',
    action: () => {
      state.chores = state.chores.filter(c => c.id !== id);
      saveData(state);
    },
  };
  render();
};

window.markChoreDone = function(id) {
  const chore = (state.chores || []).find(c => c.id === id);
  if (!chore || chore.status !== 'available') return;
  // Check if the source template has auto-approve
  const template = getChoreTemplates().find(t => t.name === chore.name && t.autoApprove);
  if (template) {
    // Auto-approve: create transaction immediately
    state.transactions.push({
      id: generateId(),
      kidId: chore.kidId,
      type: 'income',
      amount: chore.amount,
      description: chore.name,
      timestamp: Date.now(),
      createdBy: 'chore-auto',
    });
    chore.status = 'approved';
    chore.approvedAt = Date.now();
  } else {
    chore.status = 'pending';
    chore.completedAt = Date.now();
  }
  saveData(state);
  render();
};

window.addChoreFromTemplate = function(templateId) {
  const template = getChoreTemplates().find(t => t.id === templateId);
  if (!template) return;
  const kid = getActiveKid();
  if (!kid) return;
  if (!state.chores) state.chores = [];
  // Prevent duplicate active chores with same name
  const alreadyActive = state.chores.some(c => c.kidId === kid.id && c.name === template.name && (c.status === 'available' || c.status === 'pending'));
  if (alreadyActive) return;
  state.chores.push({
    id: generateId(),
    kidId: kid.id,
    name: template.name,
    amount: template.amount,
    repeating: false,
    status: 'available',
    createdAt: Date.now(),
  });
  saveData(state);
  render();
};

window.requestChoreAgain = function(id) {
  const original = (state.chores || []).find(c => c.id === id);
  if (!original) return;
  if (!state.chores) state.chores = [];
  state.chores.push({
    id: generateId(),
    kidId: original.kidId,
    name: original.name,
    amount: original.amount,
    repeating: false,
    status: 'pending',
    completedAt: Date.now(),
    createdAt: Date.now(),
  });
  saveData(state);
  render();
};

window.approveChore = function(id) {
  const chore = (state.chores || []).find(c => c.id === id);
  if (!chore || chore.status !== 'pending') return;
  state.transactions.push({
    id: generateId(),
    kidId: chore.kidId,
    type: 'income',
    amount: chore.amount,
    description: chore.name,
    category: 'chores',
    timestamp: Date.now(),
    createdBy: 'parent',
  });
  if (chore.repeating) {
    chore.status = 'available';
    chore.completedAt = undefined;
  } else {
    chore.status = 'approved';
    chore.approvedAt = Date.now();
  }
  saveData(state);
  render();
};

window.rejectChore = function(id) {
  const chore = (state.chores || []).find(c => c.id === id);
  if (!chore || chore.status !== 'pending') return;
  chore.status = 'available';
  chore.completedAt = undefined;
  saveData(state);
  render();
};

window.confirmDeleteChore = function(id) {
  confirmAction = {
    message: 'Remove this chore?',
    action: () => {
      state.chores = (state.chores || []).filter(c => c.id !== id);
      saveData(state);
    },
  };
  render();
};

window.setRecurringType = function(type) {
  recurringType = type;
  const incomeBtn = document.getElementById('recurringTypeIncome');
  const expenseBtn = document.getElementById('recurringTypeExpense');
  const catSelect = document.getElementById('recurringCategory');
  const submitBtn = document.getElementById('recurringSubmitBtn');
  if (incomeBtn) incomeBtn.className = type === 'income' ? 'active-income' : '';
  if (expenseBtn) expenseBtn.className = type === 'expense' ? 'active-expense' : '';
  if (catSelect) {
    catSelect.innerHTML = CATEGORIES[type].map(c => `<option value="${c.value}">${c.icon} ${c.label}</option>`).join('');
  }
  if (submitBtn) {
    submitBtn.style.background = type === 'expense' ? 'var(--red)' : '';
    submitBtn.className = `submit-btn ${type === 'income' ? 'green' : ''}`;
  }
};

window.submitRecurringActivity = function() {
  const kidId = document.getElementById('recurringKid').value;
  const amount = parseMoney(document.getElementById('recurringAmount').value);
  const description = document.getElementById('recurringDescription').value.trim();
  const category = document.getElementById('recurringCategory').value;
  const frequency = document.getElementById('recurringFrequency').value;
  if (!amount) { shakeElement('recurringAmount'); return; }
  if (!kidId) return;
  if (!state.recurringActivities) state.recurringActivities = [];

  if (editingRecurringId) {
    const r = state.recurringActivities.find(r => r.id === editingRecurringId);
    if (r) {
      r.kidId = kidId;
      r.type = recurringType;
      r.amount = amount;
      r.description = description || (recurringType === 'income' ? 'Recurring income' : 'Recurring expense');
      r.category = category;
      r.frequency = frequency;
    }
    editingRecurringId = null;
    saveData(state);
  } else {
    const now = Date.now();
    const recurring = {
      id: generateId(),
      kidId,
      type: recurringType,
      amount,
      description: description || (recurringType === 'income' ? 'Recurring income' : 'Recurring expense'),
      category,
      frequency,
      nextDue: now,
      active: true,
      createdAt: now,
    };
    state.recurringActivities.push(recurring);
    processRecurringActivities();
    saveData(state);
  }
  modalOpen = null;
  render();
};

window.openEditRecurringModal = function(id) {
  const r = (state.recurringActivities || []).find(r => r.id === id);
  if (!r) return;
  editingRecurringId = id;
  recurringType = r.type;
  modalOpen = 'recurring';
  render();
};

window.toggleRecurringActive = function(id) {
  const r = (state.recurringActivities || []).find(r => r.id === id);
  if (!r) return;
  r.active = !r.active;
  // If reactivating, reset nextDue to now so it doesn't create a backlog
  if (r.active) r.nextDue = Date.now();
  saveData(state);
  render();
};

window.confirmDeleteRecurring = function(id) {
  confirmAction = {
    message: 'Remove this recurring activity? Past transactions will remain.',
    action: () => {
      state.recurringActivities = (state.recurringActivities || []).filter(r => r.id !== id);
      saveData(state);
    },
  };
  render();
};

window.confirmDeleteTransaction = function(id) {
  confirmAction = {
    message: 'Delete this transaction? This will update the balance.',
    action: () => {
      state.transactions = state.transactions.filter(t => t.id !== id);
      saveData(state);
    },
  };
  render();
};

window.confirmDeleteGoal = function(id) {
  confirmAction = {
    message: 'Remove this saving goal?',
    action: () => {
      state.goals = state.goals.filter(g => g.id !== id);
      saveData(state);
    },
  };
  render();
};

window.confirmRemoveKid = function(index) {
  const kid = state.kids[index];
  confirmAction = {
    message: `Remove ${escapeHtml(kid.name)}? This will delete all their transactions and goals.`,
    action: () => {
      const kidId = kid.id;
      state.kids.splice(index, 1);
      state.transactions = state.transactions.filter(t => t.kidId !== kidId);
      state.goals = state.goals.filter(g => g.kidId !== kidId);
      state.chores = (state.chores || []).filter(c => c.kidId !== kidId);
      state.recurringActivities = (state.recurringActivities || []).filter(r => r.kidId !== kidId);
      if (state.activeKidIndex >= state.kids.length) {
        state.activeKidIndex = state.kids.length - 1;
      }
      saveData(state);
    },
  };
  render();
};

window.executeConfirm = function() {
  if (confirmAction && confirmAction.action) {
    confirmAction.action();
  }
  confirmAction = null;
  render();
};

window.cancelConfirm = function() {
  confirmAction = null;
  render();
};

window.renameKid = function(index, name) {
  if (name.trim()) {
    state.kids[index].name = name.trim();
    saveData(state);
  }
};

window.addKid = function() {
  state.kids.push({ id: generateId(), name: `Kid ${state.kids.length + 1}` });
  saveData(state);
  render();
};

window.updateDefaultState = function(stateCode) {
  selectedState = stateCode;
  localStorage.setItem('kidcash_state', stateCode);
};

// ─── Wishlist Handlers ────────────────────────────────────────
window.openWishlistShare = function(kidId) {
  shareModalKidId = kidId;
  wishlistShareClaims = null;
  modalOpen = 'wishlist-share';
  render();
  const token = (state.wishlistShares || {})[kidId];
  if (token) loadWishlistClaims(token);
};

async function loadWishlistClaims(token) {
  wishlistShareClaims = {};
  try {
    const snap = await fbGetDocs(fbCollection(firebaseDb, 'public_wishlists', token, 'claims'));
    wishlistShareClaims = {};
    snap.forEach(d => { wishlistShareClaims[d.id] = d.data(); });
  } catch (e) {
    wishlistShareClaims = null;
  }
  if (modalOpen === 'wishlist-share') render();
}

async function loadClaimsForKid(kidId, token) {
  try {
    const snap = await fbGetDocs(fbCollection(firebaseDb, 'public_wishlists', token, 'claims'));
    wishlistClaimsCache[kidId] = {};
    snap.forEach(d => { wishlistClaimsCache[kidId][d.id] = d.data(); });
  } catch (e) {
    wishlistClaimsCache[kidId] = {};
  }
  render();
}

window.refreshKidClaims = function(kidId) {
  const token = (state.wishlistShares || {})[kidId];
  if (!token) return;
  wishlistClaimsCache[kidId] = null;
  render();
  loadClaimsForKid(kidId, token);
};

window.refreshWishlistClaims = function() {
  const token = (state.wishlistShares || {})[shareModalKidId];
  if (token) loadWishlistClaims(token);
};

window.shareWishlist = async function(kidId) {
  if (!currentUser) return;
  if (!state.wishlistShares) state.wishlistShares = {};
  let token = state.wishlistShares[kidId];
  if (!token) {
    token = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    state.wishlistShares[kidId] = token;
    saveData(state);
  }
  try {
    await syncPublicWishlist(kidId, token);
  } catch (e) {
    console.error('Failed to create share:', e);
  }
  render();
};

window.revokeWishlistShare = async function(kidId) {
  const token = (state.wishlistShares || {})[kidId];
  if (!token) return;
  try {
    await fbDeleteDoc(fbDoc(firebaseDb, 'public_wishlists', token));
  } catch (e) { /* best-effort */ }
  delete state.wishlistShares[kidId];
  delete wishlistClaimsCache[kidId];
  saveData(state);
  modalOpen = null;
  render();
};

window.copyShareLink = function(url) {
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById('copyShareBtn');
    if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy Link'; }, 2000); }
  });
};

// ─── Chore Board Share ──────────────────────────────────────
let choreShareModalKidId = null;

window.openChoreShare = function(kidId) {
  choreShareModalKidId = kidId;
  modalOpen = 'choreShare';
  render();
};

window.shareChoreBoard = async function(kidId) {
  if (!currentUser) return;
  if (!state.choreShares) state.choreShares = {};
  let token = state.choreShares[kidId];
  if (!token) {
    token = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    state.choreShares[kidId] = token;
    saveData(state);
  }
  try { await syncPublicChoreBoard(kidId, token); } catch (e) { console.error('Failed to create chore share:', e); }
  render();
};

window.revokeChoreBoard = async function(kidId) {
  const token = (state.choreShares || {})[kidId];
  if (!token) return;
  try { await fbDeleteDoc(fbDoc(firebaseDb, 'public_chore_boards', token)); } catch (e) { /* best-effort */ }
  delete state.choreShares[kidId];
  delete pendingChoresCache[kidId];
  saveData(state);
  modalOpen = null;
  render();
};

window.copyChoreLink = function(url) {
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById('copyChoreLinkBtn');
    if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy Link'; }, 2000); }
  });
};

// ─── Family System ────────────────────────────────────────────

async function loadOwnerFamilyMembers() {
  if (!ownerFamilyId || !window.firebaseDb) return;
  try {
    const snap = await fbGetDocs(fbCollection(firebaseDb, 'families', ownerFamilyId, 'members'));
    ownerFamilyMembers = [];
    snap.forEach(d => ownerFamilyMembers.push(d.data()));
  } catch(e) { ownerFamilyMembers = []; }
}

async function loadContributorData() {
  if (!contributorFamilyId || !window.firebaseDb) return;
  const famSnap = await fbGetDoc(fbDoc(firebaseDb, 'families', contributorFamilyId));
  if (!famSnap.exists()) return;
  contributorFamilyData = famSnap.data();
  const ownerSnap = await fbGetDoc(fbDoc(firebaseDb, 'users', contributorFamilyData.ownerId));
  if (!ownerSnap.exists()) return;
  const ownerData = ownerSnap.data();
  contributorKids = ownerData.kids || [];
  await Promise.all(contributorKids.map(kid => loadContributorKidData(kid, ownerData)));
}

async function loadContributorKidData(kid, ownerData) {
  const wishToken = (ownerData.wishlistShares || {})[kid.id];
  const choreToken = (ownerData.choreShares || {})[kid.id];
  if (wishToken) {
    try {
      const wSnap = await fbGetDoc(fbDoc(firebaseDb, 'public_wishlists', wishToken));
      const items = wSnap.exists() ? (wSnap.data().items || []) : [];
      const claimsSnap = await fbGetDocs(fbCollection(firebaseDb, 'public_wishlists', wishToken, 'claims'));
      const claims = {};
      claimsSnap.forEach(d => { claims[d.id] = d.data(); });
      contributorWishlists[kid.id] = { token: wishToken, items, claims };
    } catch(e) { contributorWishlists[kid.id] = { token: wishToken, items: [], claims: {} }; }
  }
  if (choreToken) {
    try {
      const pendSnap = await fbGetDocs(fbCollection(firebaseDb, 'public_chore_boards', choreToken, 'pending'));
      const pending = [];
      pendSnap.forEach(d => pending.push({ id: d.id, ...d.data() }));
      contributorChores[kid.id] = { token: choreToken, pending };
    } catch(e) { contributorChores[kid.id] = { token: choreToken, pending: [] }; }
  }
}

window.refreshContributorView = async function() {
  if (!contributorFamilyId) return;
  contributorWishlists = {}; contributorChores = {};
  try { await loadContributorData(); } catch(e) {}
  render();
};

window.createFamily = async function() {
  if (!currentUser || ownerFamilyId) return;
  const fid = generateId();
  await fbSetDoc(fbDoc(firebaseDb, 'families', fid), {
    ownerId: currentUser.uid,
    name: '',
    createdAt: Date.now(),
  });
  ownerFamilyId = fid;
  state.familyId = fid;
  saveData(state);
  render();
};

window.generateFamilyInvite = async function() {
  if (!ownerFamilyId || !currentUser) return;
  const token = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  await fbSetDoc(fbDoc(firebaseDb, 'family_invites', token), {
    familyId: ownerFamilyId,
    createdBy: currentUser.uid,
    createdAt: Date.now(),
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });
  const url = new URL('join.html', window.location.href).href.split('?')[0] + '?invite=' + token;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById('copyInviteBtn');
    if (btn) { btn.textContent = '✓ Copied!'; setTimeout(() => { btn.textContent = 'Copy Invite Link'; }, 3000); }
  });
};

window.removeFamilyMember = async function(memberUid) {
  if (!ownerFamilyId) return;
  try {
    await fbDeleteDoc(fbDoc(firebaseDb, 'families', ownerFamilyId, 'members', memberUid));
    ownerFamilyMembers = ownerFamilyMembers.filter(m => m.uid !== memberUid);
    render();
  } catch(e) { console.error('Failed to remove member', e); }
};

function renderContributorShell() {
  const familyName = contributorFamilyData?.name || 'Family';
  const kidsHtml = contributorKids.length === 0
    ? `<div class="empty-state"><p>No kids set up yet. Check back soon!</p></div>`
    : contributorKids.map(kid => renderContributorKidSection(kid)).join('');

  return `
    <div class="contributor-header">
      <div class="contributor-header-top">
        <div class="contributor-logo">KidCash</div>
        <div class="contributor-family-badge">Family View</div>
      </div>
      <div class="contributor-family-name">${escapeHtml(familyName)}</div>
      <div class="contributor-actions">
        <button class="contributor-refresh-btn" onclick="refreshContributorView()">↻ Refresh</button>
        <button class="contributor-signout-btn" onclick="handleSignOut()">Sign Out</button>
      </div>
    </div>
    <div class="contributor-content">
      ${kidsHtml}
    </div>
  `;
}

function renderContributorKidSection(kid) {
  const wishData = contributorWishlists[kid.id];
  const choreData = contributorChores[kid.id];

  const wishHtml = !wishData
    ? `<p class="contributor-empty">Wishlist not shared yet.</p>`
    : wishData.items.length === 0
    ? `<p class="contributor-empty">Nothing on the wishlist yet.</p>`
    : wishData.items.map(item => {
        const claim = wishData.claims[item.id];
        const isClaimed = !!(claim?.claimedBy);
        const contributions = claim?.contributions || [];
        const totalContrib = contributions.reduce((s,c) => s + c.amount, 0);
        const pct = item.price > 0 ? Math.min(100, Math.round(totalContrib / item.price * 100)) : 0;
        return `
          <div class="contributor-wish-card ${isClaimed ? 'is-claimed' : ''}">
            ${item.image ? `<img class="contributor-wish-img" src="${escapeHtml(item.image)}" alt="" onerror="this.style.display='none'">` : ''}
            <div class="contributor-wish-info">
              <div class="contributor-wish-name">${escapeHtml(item.name)}</div>
              <div class="contributor-wish-price">${formatMoney(item.price)}</div>
              ${isClaimed ? `<div class="contributor-claimed-badge">🎁 ${escapeHtml(claim.claimedBy)} is buying this</div>` : ''}
              ${totalContrib > 0 ? `
                <div class="contributor-contrib-bar-wrap"><div class="contributor-contrib-bar" style="width:${pct}%"></div></div>
                <div class="contributor-contrib-label">${formatMoney(totalContrib)} contributed</div>
              ` : ''}
            </div>
          </div>`;
      }).join('');

  const choreItems = !choreData ? [] : choreData.pending;
  const choreHtml = choreItems.length === 0
    ? `<p class="contributor-empty">No suggestions yet. Be the first!</p>`
    : choreItems.map(c => {
        const status = c.status || 'pending';
        const statusMap = {
          pending:  { label: 'Awaiting review', cls: 'status-pending' },
          approved: { label: 'Approved ✓',      cls: 'status-approved' },
          rejected: { label: 'Not added',        cls: 'status-rejected' },
        };
        const s = statusMap[status] || statusMap.pending;
        return `
          <div class="contributor-chore-card">
            <div class="contributor-chore-info">
              <div class="contributor-chore-name">${escapeHtml(c.name)}</div>
              <div class="contributor-chore-meta">+${formatMoney(c.amount)} · from ${escapeHtml(c.addedBy || 'you')}</div>
              ${c.note ? `<div class="contributor-chore-note">"${escapeHtml(c.note)}"</div>` : ''}
            </div>
            <span class="contributor-status-badge ${s.cls}">${s.label}</span>
          </div>`;
      }).join('');

  const choreToken = choreData?.token;
  const choreBoardUrl = choreToken
    ? new URL('choreboard.html', window.location.href).href.split('?')[0] + '?id=' + choreToken
    : null;

  return `
    <div class="contributor-kid-section">
      <div class="contributor-kid-header">
        <div class="contributor-kid-avatar">${escapeHtml(kid.name.charAt(0).toUpperCase())}</div>
        <div class="contributor-kid-name">${escapeHtml(kid.name)}</div>
      </div>

      <div class="contributor-block">
        <div class="contributor-block-title">🎁 Wishlist</div>
        ${wishHtml}
      </div>

      <div class="contributor-block">
        <div class="contributor-block-title">🧹 Chore Suggestions</div>
        ${choreHtml}
        ${choreBoardUrl ? `
          <a class="contributor-suggest-btn" href="${escapeHtml(choreBoardUrl)}" target="_blank" rel="noopener noreferrer">
            + Suggest a Chore
          </a>` : ''}
      </div>
    </div>
  `;
}

async function loadPendingChoresForKid(kidId, token) {
  try {
    const snap = await fbGetDocs(fbCollection(firebaseDb, 'public_chore_boards', token, 'pending'));
    pendingChoresCache[kidId] = {};
    snap.forEach(d => { pendingChoresCache[kidId][d.id] = d.data(); });
  } catch (e) {
    pendingChoresCache[kidId] = {};
  }
  render();
}

window.refreshPendingChores = function(kidId) {
  const token = (state.choreShares || {})[kidId];
  if (!token) return;
  pendingChoresCache[kidId] = null;
  render();
  loadPendingChoresForKid(kidId, token);
};

window.approvePendingChore = async function(kidId, choreId) {
  const token = (state.choreShares || {})[kidId];
  if (!token) return;
  const pending = pendingChoresCache[kidId]?.[choreId];
  if (!pending) return;
  // Add to real chores
  if (!state.chores) state.chores = [];
  state.chores.push({
    id: generateId(),
    kidId,
    name: pending.name,
    amount: pending.amount,
    repeating: false,
    status: 'available',
    createdAt: Date.now(),
    addedBy: pending.addedBy || 'Family',
    note: pending.note || '',
  });
  // Update status in Firestore and local cache
  try {
    await fbUpdateDoc(fbDoc(firebaseDb, 'public_chore_boards', token, 'pending', choreId), {
      status: 'approved', reviewedAt: Date.now()
    });
  } catch(e) { /* best-effort */ }
  if (pendingChoresCache[kidId]) {
    pendingChoresCache[kidId][choreId] = { ...(pendingChoresCache[kidId][choreId] || {}), status: 'approved' };
  }
  saveData(state);
  render();
};

window.rejectPendingChore = async function(kidId, choreId) {
  const token = (state.choreShares || {})[kidId];
  if (!token) return;
  try {
    await fbUpdateDoc(fbDoc(firebaseDb, 'public_chore_boards', token, 'pending', choreId), {
      status: 'rejected', reviewedAt: Date.now()
    });
  } catch(e) { /* best-effort */ }
  if (pendingChoresCache[kidId]) {
    pendingChoresCache[kidId][choreId] = { ...(pendingChoresCache[kidId][choreId] || {}), status: 'rejected' };
  }
  render();
};

window.openWishlistModal = function() {
  fetchStatus = null;
  fetchedProduct = { name: '', price: '', image: null };
  modalOpen = 'wishlist';
  render();
};

window.doFetchProduct = async function() {
  const urlInput = document.getElementById('wishlistUrl');
  let url = urlInput?.value?.trim();
  if (!url) { shakeElement('wishlistUrl'); return; }
  if (!url.startsWith('http')) url = 'https://' + url;
  fetchStatus = 'loading';
  render();
  const result = await fetchProductInfo(url);
  if (result && (result.name || result.price)) {
    fetchedProduct = result;
    fetchStatus = 'done';
  } else {
    fetchStatus = 'error';
  }
  render();
  setTimeout(() => {
    const el = document.getElementById('wishlistUrl');
    if (el) el.value = url;
  }, 50);
};

window.submitWishlistItem = function() {
  const url = document.getElementById('wishlistUrl')?.value?.trim();
  const name = document.getElementById('wishlistName')?.value?.trim();
  const price = parseMoney(document.getElementById('wishlistPrice')?.value);
  const kid = getActiveKid();
  if (!name) { shakeElement('wishlistName'); return; }
  if (!price) { shakeElement('wishlistPrice'); return; }
  state.wishlist.push({
    id: generateId(),
    kidId: kid.id,
    name,
    price,
    url: url || '',
    image: fetchedProduct.image || null,
    addedAt: Date.now(),
  });
  saveData(state);
  fetchStatus = null;
  fetchedProduct = { name: '', price: '', image: null };
  modalOpen = null;
  render();
};

window.wishlistToGoal = function(id) {
  const item = state.wishlist.find(w => w.id === id);
  if (!item) return;
  const kid = getActiveKid();
  state.goals.push({
    id: generateId(),
    kidId: kid.id,
    name: item.name,
    target: item.price,
    wishlistItemId: item.id, // link back for contribution tracking
  });
  // Remove from wishlist once promoted to a goal
  state.wishlist = state.wishlist.filter(w => w.id !== id);
  saveData(state);
  render();
};

window.goalToWishlist = function(id) {
  const goal = (state.goals || []).find(g => g.id === id);
  if (!goal) return;
  const kid = getActiveKid();
  state.wishlist.push({
    id: generateId(),
    kidId: kid.id,
    name: goal.name,
    price: goal.target,
    url: '',
    image: null,
    addedAt: Date.now(),
  });
  state.goals = state.goals.filter(g => g.id !== id);
  saveData(state);
  render();
};

window.goalToPurchase = function(id) {
  const goal = (state.goals || []).find(g => g.id === id);
  if (!goal) return;
  txType = 'expense';
  pendingWishlistPurchase = { name: goal.name, price: goal.target, goalId: id };
  modalOpen = 'transaction';
  render();
};

window.wishlistToPurchase = function(id) {
  const item = state.wishlist.find(w => w.id === id);
  if (!item) return;
  pendingWishlistPurchase = item;
  txType = 'expense';
  modalOpen = 'transaction';
  render();
};

window.confirmDeleteWishlistItem = function(id) {
  confirmAction = {
    message: 'Remove this item from the wishlist?',
    action: () => {
      state.wishlist = state.wishlist.filter(w => w.id !== id);
      saveData(state);
    },
  };
  render();
};

// Clear pending wishlist purchase after transaction is submitted
const origSubmitTransaction = window.submitTransaction;
window.submitTransaction = function() {
  const pending = pendingWishlistPurchase;
  origSubmitTransaction();
  if (pending && modalOpen === null) {
    state.wishlist = state.wishlist.filter(w => w.id !== pending.id);
    pendingWishlistPurchase = null;
    saveData(state);
    render();
  }
};

// ─── Kid Mode Handlers ───────────────────────────────────────
window.selectKidForPin = function(index) {
  kidModeSelectedKid = index;
  kidModePinEntry = '';
  kidModePinError = '';
  render();
};

window.clearPinSelection = function() {
  kidModeSelectedKid = null;
  kidModePinEntry = '';
  kidModePinError = '';
  render();
};

window.enterPinDigit = function(digit) {
  if (kidModePinEntry.length >= 4) return;
  kidModePinEntry += digit;
  kidModePinError = '';
  render();
  if (kidModePinEntry.length === 4) verifyKidPin(kidModeSelectedKid, kidModePinEntry);
};

async function verifyKidPin(kidIndex, entered) {
  const kid = state.kids[kidIndex];
  if (!kid) { kidModePinEntry = ''; render(); return; }

  const lockKey = `kid_${kid.id}`;
  if (isPinLocked(lockKey)) {
    kidModePinEntry = '';
    kidModePinError = `Too many attempts. Try again in ${pinLockMinutes(lockKey)} min.`;
    render();
    return;
  }

  const salt = (currentUser?.uid || '') + (kid.id || '');
  let match = false;

  if (isPinHash(kid.pin)) {
    match = (await hashPin(entered, salt)) === kid.pin;
  } else {
    // Plaintext PIN — migrate to hash on success
    match = kid.pin === entered;
    if (match) {
      kid.pin = await hashPin(entered, salt);
      saveData(state);
    }
  }

  if (match) {
    clearPinFail(lockKey);
    kidModeLocked = false;
    kidModeKidIndex = kidIndex;
    state.activeKidIndex = kidIndex;
    currentView = 'home';
    kidModePinEntry = '';
    kidModePinError = '';
    kidModeSelectedKid = null;
  } else {
    const lock = recordPinFail(lockKey);
    kidModePinEntry = '';
    if (isPinLocked(lockKey)) {
      kidModePinError = `Too many attempts. Try again in ${pinLockMinutes(lockKey)} min.`;
    } else {
      const left = 5 - lock.fails;
      kidModePinError = `Wrong PIN.${left > 0 ? ` ${left} attempt${left === 1 ? '' : 's'} left.` : ''}`;
    }
  }
  render();
}

window.deletePinDigit = function() {
  kidModePinEntry = kidModePinEntry.slice(0, -1);
  kidModePinError = '';
  render();
};

window.lockKidMode = function() {
  kidModeLocked = true;
  kidModeKidIndex = null;
  kidModeSelectedKid = null;
  kidModePinEntry = '';
  kidModePinError = '';
  currentView = 'home';
  render();
};

window.showParentUnlockFn = function() {
  showParentUnlockModal = true;
  parentUnlockError = '';
  parentUnlockBusy = false;
  render();
  setTimeout(() => {
    const el = document.getElementById('parentUnlockPin');
    if (el) el.focus();
  }, 100);
};

window.cancelParentUnlock = function() {
  showParentUnlockModal = false;
  parentUnlockError = '';
  parentUnlockBusy = false;
  render();
};

window.attemptParentUnlock = async function() {
  const pin = document.getElementById('parentUnlockPin')?.value;
  if (!pin) {
    parentUnlockError = 'Please enter the parent PIN.';
    render();
    return;
  }
  if (!state.parentPin) {
    parentUnlockError = 'No parent PIN set. Sign out to reset.';
    render();
    return;
  }

  const lockKey = 'parent';
  if (isPinLocked(lockKey)) {
    parentUnlockError = `Too many attempts. Try again in ${pinLockMinutes(lockKey)} min.`;
    render();
    return;
  }

  const salt = currentUser?.uid || '';
  let match = false;

  if (isPinHash(state.parentPin)) {
    match = (await hashPin(pin, salt)) === state.parentPin;
  } else {
    // Plaintext — migrate to hash on success
    match = pin === state.parentPin;
    if (match) {
      state.parentPin = await hashPin(pin, salt);
      saveData(state);
    }
  }

  if (match) {
    clearPinFail(lockKey);
    showParentUnlockModal = false;
    parentUnlockBusy = false;
    parentUnlockError = '';
    kidModeLocked = false;
    kidModeKidIndex = null;
    kidModeEnabled = false;
    localStorage.setItem('kidcash_kidmode', 'false');
    currentView = 'home';
    render();
  } else {
    const lock = recordPinFail(lockKey);
    if (isPinLocked(lockKey)) {
      parentUnlockError = `Too many attempts. Try again in ${pinLockMinutes(lockKey)} min.`;
    } else {
      const left = 5 - lock.fails;
      parentUnlockError = `Incorrect PIN.${left > 0 ? ` ${left} attempt${left === 1 ? '' : 's'} left.` : ''}`;
    }
    render();
  }
};

window.setKidPin = async function(index, value) {
  const cleaned = value.replace(/\D/g, '').slice(0, 4);
  if (cleaned.length === 4) {
    const kid = state.kids[index];
    const salt = (currentUser?.uid || '') + (kid?.id || '');
    state.kids[index].pin = await hashPin(cleaned, salt);
  } else {
    state.kids[index].pin = undefined;
  }
  saveData(state);
  render();
};

window.toggleParentPinVisibility = function() {
  const input = document.getElementById('parentPinInput');
  const icon = document.getElementById('pinEyeIcon');
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    // Swap to eye-off icon
    icon.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>';
  } else {
    input.type = 'password';
    // Swap to eye icon
    icon.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>';
  }
};

window.setPaymentHandle = function(field, value) {
  // Strip leading @, spaces, and any non-alphanumeric/hyphen/underscore chars
  const cleaned = value.replace(/^@/, '').replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 30);
  state[field] = cleaned || undefined;
  saveData(state);
};

window.setAppleCash = function(value) {
  const trimmed = value.trim().slice(0, 50);
  // Accept phone numbers (digits, spaces, +, -, (, )) or email addresses
  const isPhone = /^[+\d][\d\s\-().]{6,}$/.test(trimmed);
  const isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed);
  state.appleCash = (isPhone || isEmail) ? trimmed : undefined;
  saveData(state);
};

window.setParentPin = async function(value) {
  const cleaned = value.replace(/\D/g, '').slice(0, 4);
  if (cleaned.length === 4) {
    const salt = currentUser?.uid || '';
    state.parentPin = await hashPin(cleaned, salt);
  } else {
    state.parentPin = undefined;
  }
  saveData(state);
  render();
};

window.toggleKidMode = function() {
  if (!kidModeEnabled) {
    // Enabling — validate requirements
    const kidsWithPins = state.kids.filter(k => k.pin && (isPinHash(k.pin) || k.pin.length === 4));
    if (kidsWithPins.length === 0) {
      alert('Set a 4-digit PIN for at least one kid before enabling Kid Mode.');
      return;
    }
    if (!state.parentPin || !(isPinHash(state.parentPin) || state.parentPin.length === 4)) {
      alert('Set a 4-digit Parent PIN before enabling Kid Mode.');
      return;
    }
    kidModeEnabled = true;
    localStorage.setItem('kidcash_kidmode', 'true');
    kidModeLocked = true;
    kidModeKidIndex = null;
    currentView = 'home';
  } else {
    // Disabling
    kidModeEnabled = false;
    localStorage.setItem('kidcash_kidmode', 'false');
    kidModeLocked = false;
    kidModeKidIndex = null;
  }
  render();
};

// ─── Auth Handlers ───────────────────────────────────────────
window.toggleAuthMode = function() {
  authMode = authMode === 'login' ? 'signup' : 'login';
  authError = '';
  authMessage = '';
  render();
};

window.setAuthMode = function(mode) {
  authMode = mode;
  authError = '';
  authMessage = '';
  render();
};

function friendlyAuthError(code) {
  switch (code) {
    case 'auth/email-already-in-use': return 'An account with this email already exists.';
    case 'auth/invalid-email': return 'Please enter a valid email address.';
    case 'auth/user-not-found': return 'No account found with this email.';
    case 'auth/wrong-password': return 'Incorrect password.';
    case 'auth/weak-password': return 'Password must be at least 6 characters.';
    case 'auth/too-many-requests': return 'Too many attempts. Please try again later.';
    case 'auth/invalid-credential': return 'Invalid email or password.';
    case 'auth/popup-closed-by-user': return 'Sign-in popup was closed.';
    case 'auth/missing-email': return 'Please enter your email address.';
    default: return 'Something went wrong. Please try again.';
  }
}

window.handleAuth = async function() {
  const email = document.getElementById('authEmail')?.value?.trim();
  const password = document.getElementById('authPassword')?.value;
  if (!email || !password) {
    authError = 'Please enter your email and password.';
    render();
    return;
  }
  if (authMode === 'signup') {
    const confirm = document.getElementById('authPasswordConfirm')?.value;
    if (password !== confirm) {
      authError = 'Passwords do not match.';
      render();
      return;
    }
  }
  authBusy = true;
  authError = '';
  render();
  try {
    if (authMode === 'signup') {
      const result = await fbCreateAccount(firebaseAuth, email, password);
      // Send verification email to new user
      try { await fbSendEmailVerification(result.user); } catch (ev) { console.warn('Verification email failed:', ev); }
    } else {
      await fbSignInWithEmail(firebaseAuth, email, password);
    }
    // onAuthStateChanged will handle the rest
  } catch (e) {
    authBusy = false;
    authError = friendlyAuthError(e.code);
    render();
  }
};

window.handleGoogleSignIn = async function() {
  authBusy = true;
  authError = '';
  try {
    await fbSignInWithGoogle(firebaseAuth, firebaseGoogleProvider);
  } catch (e) {
    authBusy = false;
    authError = friendlyAuthError(e.code);
    console.error('Google sign-in error:', e);
    render();
  }
};

window.handleForgotPassword = async function() {
  const email = document.getElementById('authEmail')?.value?.trim();
  if (!email) {
    authError = 'Please enter your email address.';
    authMessage = '';
    render();
    return;
  }
  authBusy = true;
  authError = '';
  authMessage = '';
  render();
  try {
    await fbSendPasswordResetEmail(firebaseAuth, email);
    authBusy = false;
    authMessage = 'Check your email for a password reset link.';
    authError = '';
    render();
  } catch (e) {
    authBusy = false;
    authError = friendlyAuthError(e.code);
    authMessage = '';
    render();
  }
};

window.handleResendVerification = async function() {
  if (!currentUser) return;
  try {
    await fbSendEmailVerification(currentUser);
    alert('Verification email sent! Check your inbox.');
  } catch (e) {
    alert('Could not send verification email. Try again later.');
    console.error('Resend verification failed:', e);
  }
};

window.handleSignOut = async function() {
  try {
    await fbSignOut(firebaseAuth);
    currentUser = null;
    state = getDefaultData();
    state.wishlist = [];
    currentView = 'home';
    // Clear kid mode state
    kidModeEnabled = false;
    kidModeLocked = false;
    kidModeKidIndex = null;
    kidModeSelectedKid = null;
    kidModePinEntry = '';
    kidModePinError = '';
    showParentUnlockModal = false;
    // Clear contributor/family state
    contributorRole = null; contributorFamilyId = null; contributorFamilyData = null;
    contributorKids = []; contributorWishlists = {}; contributorChores = {};
    ownerFamilyId = null; ownerFamilyMembers = [];
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem('kidcash_state');
    localStorage.removeItem('kidcash_kidmode');
    render();
  } catch (e) {
    console.error('Sign out failed:', e);
  }
};

// ─── Helpers ──────────────────────────────────────────────────
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Returns the product URL, with a hook for future affiliate/referral parameters.
// To add referral revenue: replace the return with an affiliate link builder.
function buildProductUrl(url) {
  if (!url) return null;
  const safe = sanitizeUrl(url);
  return safe === '#' ? null : safe;
}

function sanitizeUrl(url) {
  if (!url) return '#';
  try {
    const parsed = new URL(url, 'https://placeholder.com');
    // Only allow http/https — blocks javascript:, data:, blob:, etc.
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
  } catch {}
  return '#';
}

function sanitizeId(id) {
  return typeof id === 'string' ? id.replace(/[^a-z0-9]/gi, '') : '';
}

function shakeElement(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.borderColor = 'var(--red)';
  el.style.animation = 'none';
  el.offsetHeight;
  el.style.animation = 'shake 0.4s ease';
  setTimeout(() => { el.style.borderColor = ''; }, 1500);
}

const shakeStyle = document.createElement('style');
shakeStyle.textContent = `
  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    20%, 60% { transform: translateX(-6px); }
    40%, 80% { transform: translateX(6px); }
  }
`;
document.head.appendChild(shakeStyle);

// ─── Init ─────────────────────────────────────────────────────

// Show loading spinner immediately
render();

function initAuth() {
  fbOnAuthStateChanged(firebaseAuth, async (user) => {
    try {
      if (user) {
        currentUser = user;
        authBusy = false;
        appReady = false;
        render(); // show spinner while loading data
        await loadFromFirestore(user.uid);
        // Restore kid mode from localStorage after data loads
        kidModeEnabled = localStorage.getItem('kidcash_kidmode') === 'true';
        kidModeLocked = kidModeEnabled;
        kidModeKidIndex = null;
        processRecurringActivities();
        appReady = true;
        render();
      } else {
        currentUser = null;
        authBusy = false;
        appReady = true;
        render();
      }
    } catch (e) {
      console.error('Auth state handler error:', e);
      // Still show the app even if Firestore fails
      appReady = true;
      render();
    }
  });
}

// Firebase module loads async — wait for it
if (window.fbOnAuthStateChanged) {
  initAuth();
} else {
  window.addEventListener('firebase-ready', initAuth);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
