// dev mixer over the recap, toggled with __recapMix(). every change plays live and lands in
// userData/recap-mix.json half a second later, to be read back and written into audio.ts
import { useSyncExternalStore } from "react";
import { Play } from "lucide-react";
import * as au from "./audio";
import { useRecap } from "./recapStore";

const BUSES: Array<[keyof au.Mix["bus"], string]> = [
  ["master", "Master"],
  ["music", "Music"],
  ["sfx", "Effects"],
  ["ui", "Ui ticks"],
  ["room", "Room (reverb)"],
];

const db = (v: number) => (v <= 0.0001 ? "off" : `${(20 * Math.log10(v)).toFixed(1)} dB`);

function Fader(props: { label: string; value: number; max?: number; onChange(v: number): void; small?: boolean }) {
  return (
    <label className={"rc-mix-fader" + (props.small ? " rc-mix-small" : "")}>
      <span>{props.label}</span>
      <input type="range" min={0} max={props.max ?? 2} step={0.01} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} onDoubleClick={() => props.onChange(1)} />
      <em>{db(props.value)}</em>
    </label>
  );
}

export function MixPanel() {
  const { mixer } = useRecap();
  const mix = useSyncExternalStore(au.subscribeMix, au.getMix);
  if (!mixer) return null;
  const setBus = (k: keyof au.Mix["bus"], v: number) => au.setMix({ ...mix, bus: { ...mix.bus, [k]: v } });
  const setCue = (c: au.Cue, k: "gain" | "room", v: number) => au.setMix({ ...mix, cue: { ...mix.cue, [c]: { ...mix.cue[c], [k]: v } } });
  return (
    // keys typed here (arrows on a slider) must not page the recap
    <div className="rc-mix" onKeyDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <div className="rc-mix-head">
        <b>Mixer</b>
        <button type="button" onClick={() => au.resetMix()}>
          Reset
        </button>
        <button type="button" onClick={() => void navigator.clipboard.writeText(JSON.stringify(mix, null, 2))}>
          Copy
        </button>
        <button type="button" onClick={() => (window as unknown as { __recapMix(): void }).__recapMix()}>
          Close
        </button>
      </div>
      <p className="rc-mix-note">Double click a slider for 0 dB. {au.mixFile() ? `Saved to ${au.mixFile()}` : "Saves to userData/recap-mix.json on change."}</p>
      <h4>Buses</h4>
      {BUSES.map(([k, l]) => (
        <Fader key={k} label={l} value={mix.bus[k]} onChange={(v) => setBus(k, v)} />
      ))}
      {au.CUES.map(([group, cues]) => (
        <div key={group}>
          <h4>{group}</h4>
          {cues.map(([c, where]) => (
            <div key={c} className="rc-mix-cue">
              <div className="rc-mix-name">
                <button type="button" title="Play" onClick={() => au.play(c)}>
                  <Play size={11} />
                </button>
                <b>{c}</b>
                <span>{where}</span>
              </div>
              <Fader label="level" value={mix.cue[c]?.gain ?? 1} max={3} onChange={(v) => setCue(c, "gain", v)} />
              <Fader label="room" value={mix.cue[c]?.room ?? 1} max={4} small onChange={(v) => setCue(c, "room", v)} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
