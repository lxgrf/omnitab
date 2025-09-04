/*
  Omnitab background script (MV2-compatible)
  Mirrors logical tabs across all non-private windows.
*/

// Polyfill storage.session for MV2
if (!browser.storage.session) {
	browser.storage.session = {
		_data: {},
		async get(key) {
			if (typeof key === 'string') {
				return { [key]: this._data[key] };
			}
			if (Array.isArray(key)) {
				const out = {};
				for (const k of key) out[k] = this._data[k];
				return out;
			}
			return { ...this._data };
		},
		async set(obj) {
			Object.assign(this._data, obj);
		},
		async remove(keys) {
			for (const k of (Array.isArray(keys) ? keys : [keys])) delete this._data[k];
		},
		async clear() { this._data = {}; }
	};
}

// Session storage keys
const SESSION_KEYS = {
	workspace: 'workspace', // { logicalId: { url, pinned, perWindow: { [windowId]: tabId } } }
	reverseIndex: 'reverseIndex' // { [tabId]: logicalId }
};

// In-memory suppression guards to avoid event feedback loops
let suppressCreateDepth = 0;
const suppressedUpdatedTabIds = new Set();
const suppressedActivatedTabIds = new Set();
const suppressedRemovedTabIds = new Set();

function runWithCreateSuppressed(fn) {
	suppressCreateDepth += 1;
	const done = () => { suppressCreateDepth = Math.max(0, suppressCreateDepth - 1); };
	try {
		const p = Promise.resolve(fn());
		p.finally(done);
		return p;
	} catch (e) {
		done();
		throw e;
	}
}

function isMirrorableUrl(url) {
	if (!url || typeof url !== 'string') return false;
	return url.startsWith('http://') || url.startsWith('https://');
}

async function readSession(key) {
	const data = await browser.storage.session.get(key);
	return data[key];
}

async function writeSession(key, value) {
	await browser.storage.session.set({ [key]: value });
}

async function withWorkspace(fn) {
	const workspace = (await readSession(SESSION_KEYS.workspace)) || {};
	const reverseIndex = (await readSession(SESSION_KEYS.reverseIndex)) || {};
	const result = await fn({ workspace, reverseIndex });
	if (result && (result.workspace || result.reverseIndex)) {
		if (result.workspace) await writeSession(SESSION_KEYS.workspace, result.workspace);
		if (result.reverseIndex) await writeSession(SESSION_KEYS.reverseIndex, result.reverseIndex);
	}
}

function generateLogicalId() {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function listNormalWindows() {
	const wins = await browser.windows.getAll({ populate: false, windowTypes: ['normal'] });
	return wins.filter(w => !w.incognito);
}

async function ensureMirrorsForTab(tab) {
	if (!tab || tab.incognito || tab.windowId === undefined) return;
	if (tab.pinned) return; // ignore pinned tabs entirely
	if (!isMirrorableUrl(tab.url)) return;
	await withWorkspace(async ({ workspace, reverseIndex }) => {
		let logicalId = reverseIndex[tab.id];
		if (!logicalId) {
			// Try to find an existing logical with same URL
			for (const [candidateId, entry] of Object.entries(workspace)) {
				if (entry.url === tab.url) {
					logicalId = candidateId;
					break;
				}
			}
			if (!logicalId) {
				logicalId = generateLogicalId();
				workspace[logicalId] = {
					url: tab.url,
					pinned: false,
					perWindow: {}
				};
			}
			workspace[logicalId].perWindow[tab.windowId] = tab.id;
			reverseIndex[tab.id] = logicalId;
		}

		const normalWindows = await listNormalWindows();
		const targetWindowIds = new Set(normalWindows.map(w => w.id));
		const perWindow = workspace[logicalId].perWindow;

		// Create mirrors in missing windows
		for (const win of normalWindows) {
			if (!perWindow[win.id]) {
				await runWithCreateSuppressed(async () => {
					try {
						const created = await browser.tabs.create({
							windowId: win.id,
							url: workspace[logicalId].url,
							active: false
						});
						perWindow[win.id] = created.id;
						reverseIndex[created.id] = logicalId;
					} catch (e) {
						// Best effort, ignore window that might be closing
					}
				});
			}
		}

		// Remove mirrors from windows that no longer exist
		for (const [winIdStr, mirrorTabId] of Object.entries(perWindow)) {
			const winId = Number(winIdStr);
			if (!targetWindowIds.has(winId)) {
				delete perWindow[winId];
				delete reverseIndex[mirrorTabId];
			}
		}

		return { workspace, reverseIndex };
	});
}

async function removeLogicalIfEmpty(logicalId) {
	await withWorkspace(async ({ workspace, reverseIndex }) => {
		const entry = workspace[logicalId];
		if (!entry) return;
		if (Object.keys(entry.perWindow).length === 0) {
			delete workspace[logicalId];
		}
		return { workspace, reverseIndex };
	});
}

// Event: new tab created
browser.tabs.onCreated.addListener(async (tab) => {
	if (tab.incognito) return;
	if (tab.pinned) return;
	if (suppressCreateDepth > 0) return;
	await ensureMirrorsForTab(tab);
});

// Event: tab removed
browser.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
	if (removeInfo.isWindowClosing) return;
	let logicalId;
	await withWorkspace(async ({ workspace, reverseIndex }) => {
		logicalId = reverseIndex[tabId];
		if (!logicalId) return { workspace, reverseIndex };

		// Remove this tab from indexes first
		delete reverseIndex[tabId];
		const perWindow = workspace[logicalId]?.perWindow || {};
		for (const [winIdStr, id] of Object.entries(perWindow)) {
			if (Number(winIdStr) === removeInfo.windowId && id === tabId) {
				delete perWindow[removeInfo.windowId];
				break;
			}
		}

		// If this removal was initiated by us, don't propagate closes
		if (suppressedRemovedTabIds.has(tabId)) {
			return { workspace, reverseIndex };
		}

		// Close remaining mirrors in other windows
		for (const [winIdStr, mirrorId] of Object.entries(workspace[logicalId].perWindow)) {
			if (Number(winIdStr) === removeInfo.windowId && mirrorId === tabId) continue;
			try {
				suppressedRemovedTabIds.add(mirrorId);
				await browser.tabs.remove(mirrorId);
				// clean up will happen in their own onRemoved events
				setTimeout(() => suppressedRemovedTabIds.delete(mirrorId), 1000);
			} catch (_) {}
		}

		return { workspace, reverseIndex };
	});
	if (logicalId) await removeLogicalIfEmpty(logicalId);
});

// Event: tab updated (URL change)
browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
	if (tab.incognito) return;
	if (tab.pinned) return;
	if (!changeInfo.url) return;
	if (!isMirrorableUrl(changeInfo.url)) return;
	if (suppressedUpdatedTabIds.has(tabId)) return;
	await withWorkspace(async ({ workspace, reverseIndex }) => {
		let logicalId = reverseIndex[tabId];
		// If this tab didn't exist in our mapping (e.g. created as about:newtab), create mapping now
		if (!logicalId) {
			// Try to attach to an existing logical entry with same URL
			for (const [candidateId, entry] of Object.entries(workspace)) {
				if (entry.url === changeInfo.url) {
					logicalId = candidateId;
					break;
				}
			}
			if (!logicalId) {
				logicalId = generateLogicalId();
				workspace[logicalId] = {
					url: changeInfo.url,
					pinned: false,
					perWindow: {}
				};
			}
			workspace[logicalId].perWindow[tab.windowId] = tabId;
			reverseIndex[tabId] = logicalId;
		}

		const entry = workspace[logicalId];
		if (entry.url !== changeInfo.url) {
			entry.url = changeInfo.url;
		}
		// Update mirrors if their URL differs
		for (const [winIdStr, mirrorId] of Object.entries(entry.perWindow)) {
			if (Number(winIdStr) === tab.windowId && mirrorId === tabId) continue;
			try {
				const mirrorTab = await browser.tabs.get(mirrorId).catch(() => null);
				if (!mirrorTab) continue;
				if (mirrorTab.url === changeInfo.url) continue;
				suppressedUpdatedTabIds.add(mirrorId);
				await browser.tabs.update(mirrorId, { url: changeInfo.url });
				setTimeout(() => suppressedUpdatedTabIds.delete(mirrorId), 1000);
			} catch (_) {}
		}
		return { workspace, reverseIndex };
	});
	// Ensure mirrors exist in other windows after first navigation
	await ensureMirrorsForTab(tab);
});

// Event: tab moved (index change) - try to mirror order
browser.tabs.onMoved.addListener(async (tabId, moveInfo) => {
	const current = await browser.tabs.get(tabId).catch(() => null);
	if (!current || current.incognito) return;
	if (current.pinned) return;
	await withWorkspace(async ({ workspace, reverseIndex }) => {
		const logicalId = reverseIndex[tabId];
		if (!logicalId) return;
		const entry = workspace[logicalId];
		for (const [winIdStr, mirrorId] of Object.entries(entry.perWindow)) {
			const winId = Number(winIdStr);
			if (winId === current.windowId && mirrorId === tabId) continue;
			try {
				await browser.tabs.move(mirrorId, { index: moveInfo.toIndex });
			} catch (_) {}
		}
		return { workspace, reverseIndex };
	});
});

// Event: active tab changed - reflect focus where possible
browser.tabs.onActivated.addListener(async (activeInfo) => {
	if (suppressedActivatedTabIds.has(activeInfo.tabId)) return;
	const tab = await browser.tabs.get(activeInfo.tabId).catch(() => null);
	if (!tab || tab.incognito) return;
	if (tab.pinned) return;
	await withWorkspace(async ({ workspace, reverseIndex }) => {
		const logicalId = reverseIndex[activeInfo.tabId];
		if (!logicalId) return;
		const entry = workspace[logicalId];
		for (const [winIdStr, mirrorId] of Object.entries(entry.perWindow)) {
			const winId = Number(winIdStr);
			if (winId === tab.windowId && mirrorId === tab.id) continue;
			try {
				suppressedActivatedTabIds.add(mirrorId);
				await browser.tabs.update(mirrorId, { active: true });
				setTimeout(() => suppressedActivatedTabIds.delete(mirrorId), 500);
			} catch (_) {}
		}
		return { workspace, reverseIndex };
	});
});

// Windows: when a new window opens, mirror all logical tabs into it
browser.windows.onCreated.addListener(async (window) => {
	if (window.incognito || window.type !== 'normal') return;
	await withWorkspace(async ({ workspace, reverseIndex }) => {
		for (const [logicalId, entry] of Object.entries(workspace)) {
			if (!isMirrorableUrl(entry.url)) continue;
			await runWithCreateSuppressed(async () => {
				try {
					const created = await browser.tabs.create({
						windowId: window.id,
						url: entry.url,
						active: false
					});
					entry.perWindow[window.id] = created.id;
					reverseIndex[created.id] = logicalId;
				} catch (_) {}
			});
		}
		return { workspace, reverseIndex };
	});
});

// Windows: when a window is removed, clean its mirrors
browser.windows.onRemoved.addListener(async (windowId) => {
	await withWorkspace(async ({ workspace, reverseIndex }) => {
		for (const [logicalId, entry] of Object.entries(workspace)) {
			const mirrorId = entry.perWindow[windowId];
			if (mirrorId) {
				delete entry.perWindow[windowId];
				delete reverseIndex[mirrorId];
			}
		}
		return { workspace, reverseIndex };
	});
});

// On startup: build workspace from existing windows/tabs (dedupe by URL)
async function initialiseFromExisting() {
	await writeSession(SESSION_KEYS.workspace, {});
	await writeSession(SESSION_KEYS.reverseIndex, {});
	const windows = await listNormalWindows();
	const workspace = {};
	const reverseIndex = {};
	const byKey = new Map(); // url -> logicalId
	for (const win of windows) {
		const tabs = await browser.tabs.query({ windowId: win.id });
		for (const tab of tabs) {
			if (tab.incognito) continue;
			if (tab.pinned) continue;
			if (!isMirrorableUrl(tab.url)) continue;
			const key = tab.url;
			let logicalId = byKey.get(key);
			if (!logicalId) {
				logicalId = generateLogicalId();
				byKey.set(key, logicalId);
				workspace[logicalId] = {
					url: tab.url,
					pinned: false,
					perWindow: {}
				};
			}
			workspace[logicalId].perWindow[win.id] = tab.id;
			reverseIndex[tab.id] = logicalId;
		}
	}
	await writeSession(SESSION_KEYS.workspace, workspace);
	await writeSession(SESSION_KEYS.reverseIndex, reverseIndex);

	// After mapping, ensure mirrors exist in all windows
	for (const [logicalId, entry] of Object.entries(workspace)) {
		const normalWindows = await listNormalWindows();
		for (const win of normalWindows) {
			if (!entry.perWindow[win.id]) {
				await runWithCreateSuppressed(async () => {
					try {
						const created = await browser.tabs.create({
							windowId: win.id,
							url: entry.url,
							active: false
						});
						entry.perWindow[win.id] = created.id;
						reverseIndex[created.id] = logicalId;
						await writeSession(SESSION_KEYS.reverseIndex, reverseIndex);
						await writeSession(SESSION_KEYS.workspace, workspace);
					} catch (_) {}
				});
			}
		}
	}
}

// Fire on startup / install
initialiseFromExisting();
