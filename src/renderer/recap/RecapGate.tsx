import { Suspense, lazy, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { RecapData } from "../../types/clips";
import { useProfile } from "../shell/useProfile";
import { closeRecap, useRecap } from "./recapStore";

// the recap, its fonts and styles load as their own chunk on first open
const Recap = lazy(() => import("./Recap"));

/** the recap overlay, mounted app-wide; the rail pill opens it */
export default function RecapGate() {
  const { open, year } = useRecap();
  return <AnimatePresence>{open ? <Overlay key={year} year={year} /> : null}</AnimatePresence>;
}

function Overlay({ year }: { year: number }) {
  const profile = useProfile();
  const [data, setData] = useState<RecapData | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    window.clips
      .getRecap(year)
      // nothing back would leave a blank overlay that only Escape closes
      .then((d) => live && (d ? setData(d) : setFailed(true)))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [year]);

  // the recap handles keys once it's up, this covers the moment before
  useEffect(() => {
    if (data) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRecap();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [data]);

  // no voice data means no owner from the recorder, the Setsu account stands in
  const owner = data?.owner
    ? { name: data.owner.name, handle: data.owner.handle, av: data.owner.avatar }
    : { name: profile.connected ? profile.username : "You", handle: "", av: profile.connected ? profile.avatarUrl || null : null };

  return (
    <motion.div
      className="rc-shell"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.45, ease: "easeOut" }}
    >
      {data ? (
        <Suspense fallback={null}>
          <Recap data={data} owner={owner} onClose={closeRecap} />
        </Suspense>
      ) : null}
      {failed ? (
        <div className="rc-shell-error">
          <span>Couldn't put your recap together.</span>
          <button type="button" onClick={closeRecap}>
            Close
          </button>
        </div>
      ) : null}
    </motion.div>
  );
}
