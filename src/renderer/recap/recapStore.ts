// the year recap is hidden until it ships. in the devtools console __recap() turns its rail
// button on and remembers that across launches, __recap(false) turns it off, __recap(2025) points
// it at another year for this session. even on, the button only shows once main says the year
// has enough to recap (recapEligible: 10 clips on 3 days); __recap("force") shows it regardless. __recapMix() toggles the sound mixer over the recap,
// __recapShare() saves the shared page's payload (below). once a year's recap has been seen through,
// its rail button flies into the settings button and from then on only shows in the settings rail;
// __recapFly() plays that now as if the recap was just finished, __recapUndock() puts it back.
// kept in production builds on purpose, like __showOnboarding
import { useSyncExternalStore } from "react";

const KEY = "clip-library:recap-pill";
const FORCE_KEY = "clip-library:recap-force";

interface RecapState {
  enabled: boolean;
  year: number;
  open: boolean;
  mixer: boolean;
  /** this year's card was revealed at least once */
  finished: boolean;
  /** the rail button already flew into settings for this year */
  docked: boolean;
  /** bumped by __recapFly() to fly right away, without waiting for the pointer */
  flyNow: number;
  /** the year has enough for a recap; null until main has answered */
  eligible: boolean | null;
  /** the year that answer is for */
  eligibleYear: number | null;
  /** __recap("force"): the button shows whether the year has enough or not */
  force: boolean;
}

const readKey = (k: string) => {
  try {
    return localStorage.getItem(k) === "1";
  } catch {
    return false;
  }
};
const writeKey = (k: string, on: boolean) => {
  try {
    localStorage.setItem(k, on ? "1" : "0");
  } catch {
    /* ignore */
  }
};

const flag = (name: string, year: number) => `clip-library:recap-${name}-${year}`;
const readFlag = (name: string, year: number) => {
  try {
    return localStorage.getItem(flag(name, year)) === "1";
  } catch {
    return false;
  }
};
const writeFlag = (name: string, year: number, on: boolean) => {
  try {
    if (on) localStorage.setItem(flag(name, year), "1");
    else localStorage.removeItem(flag(name, year));
  } catch {
    /* ignore */
  }
};
const flagsFor = (year: number) => ({ finished: readFlag("finished", year), docked: readFlag("docked", year) });

const year0 = new Date().getFullYear();
// one store per window, kept on it: when the dev server hot-swapped this module the copies each had
// their own state, the recap marked one finished while the rail button watched the other
const G = window as unknown as { __recapStore?: { state: RecapState; listeners: Set<() => void> } };
const store = (G.__recapStore ??= {
  state: { enabled: readKey(KEY), year: year0, open: false, mixer: false, flyNow: 0, eligible: null, eligibleYear: null, force: readKey(FORCE_KEY), ...flagsFor(year0) },
  listeners: new Set(),
});

function set(next: Partial<RecapState>): void {
  store.state = { ...store.state, ...next };
  for (const l of store.listeners) l();
}

function subscribe(cb: () => void): () => void {
  store.listeners.add(cb);
  return () => store.listeners.delete(cb);
}

export function useRecap(): RecapState {
  return useSyncExternalStore(subscribe, () => store.state);
}

export const openRecap = () => set({ open: true });
export const closeRecap = () => set({ open: false });
export const markRecapFinished = () => {
  if (store.state.finished) return;
  writeFlag("finished", store.state.year, true);
  set({ finished: true });
};
export const markRecapDocked = () => {
  writeFlag("docked", store.state.year, true);
  set({ docked: true });
};

let asking: number | null = null;
/** asks main once per year whether there's enough for a recap; the rail button waits on the answer */
export function checkRecapEligible(): void {
  const year = store.state.year;
  if (store.state.eligibleYear === year || asking === year || !window.clips?.recapEligible) return;
  asking = year;
  window.clips
    .recapEligible(year)
    .then((r) => {
      if (store.state.year === year) set({ eligible: Boolean(r?.ok), eligibleYear: year });
      if (r && !r.ok) console.info(`recap: ${year} has ${r.clips} clips on ${r.days} days, needs ${r.need.clips} on ${r.need.days}. __recap("force") shows the button anyway`);
    })
    .catch(() => store.state.year === year && set({ eligible: false, eligibleYear: year }))
    .finally(() => {
      if (asking === year) asking = null;
    });
}

(window as unknown as Record<string, unknown>).__recap = (arg?: boolean | number | "force") => {
  const on = arg !== false;
  writeKey(KEY, on);
  if (!on) {
    writeKey(FORCE_KEY, false);
    set({ enabled: false, open: false, force: false });
    return "recap: button hidden";
  }
  const force = arg === "force" || store.state.force;
  if (arg === "force") writeKey(FORCE_KEY, true);
  const year = typeof arg === "number" ? arg : store.state.year;
  set({ enabled: true, year, force, ...(year !== store.state.year ? { eligible: null, eligibleYear: null } : {}), ...flagsFor(year) });
  if (!force) checkRecapEligible();
  return force ? `recap: button forced on for ${year}` : `recap: button on for ${year}, it shows if the year has enough clips`;
};

(window as unknown as Record<string, unknown>).__recapFly = () => {
  writeFlag("finished", store.state.year, true);
  writeFlag("docked", store.state.year, false);
  set({ enabled: true, finished: true, docked: false, flyNow: (store.state.flyNow || 0) + 1 });
  return "recap: flying into settings";
};

(window as unknown as Record<string, unknown>).__recapUndock = () => {
  writeFlag("finished", store.state.year, false);
  writeFlag("docked", store.state.year, false);
  set({ finished: false, docked: false });
  return `recap: button back in the rail for ${store.state.year}`;
};

(window as unknown as Record<string, unknown>).__recapMix = () => {
  set({ mixer: !store.state.mixer });
  return store.state.mixer ? "recap: mixer shown, saves to userData/recap-mix.json" : "recap: mixer hidden";
};

// __recapShare() saves the payload a share would upload, pictures in it, for the shared recap page
// (web/recap-share), to try the page with real numbers. __recapShare({ friends: true }) puts the
// crew in too
(window as unknown as Record<string, unknown>).__recapShare = async (o: { friends?: boolean; year?: number } = {}) => {
  const year = o.year ?? store.state.year;
  const [{ buildModel }, { sharePayloadWithPics }, data] = await Promise.all([import("./model"), import("./share"), window.clips.getRecap(year)]);
  const owner = data.owner ? { name: data.owner.name, handle: data.owner.handle, av: data.owner.avatar } : { name: "You", handle: "", av: null };
  const D = buildModel(data, owner);
  const p = await sharePayloadWithPics(D, { friends: o.friends === true }, (srcs) => window.clips.recapInlineImages(srcs));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(p, null, 2)], { type: "application/json" }));
  a.download = `setsu-recap-${year}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return p;
};
