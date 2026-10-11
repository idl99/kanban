import { useMemo, useState } from "react";
import type { Profile } from "./api";
import { avatarColor, avatarLetter } from "./avatar";
import { fuzzyMatch } from "./fuzzy";
import { boardDigit } from "./keynav";
import { CheckIcon } from "./icons";
import { Modal } from "./Modal";

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? "⌘" : "Ctrl";

const GROUPS: { title: string; keys: [string[], string][] }[] = [
  {
    title: "Boards",
    keys: [
      [[MOD, "K"], "Command bar: tickets on every board, actions, boards"],
      [["B"], "Switch board"],
      [["[", "]"], "Previous / next board"],
      [["1…9"], "Go to board 1–9"],
    ],
  },
  {
    title: "Board",
    keys: [
      [["N"], "New ticket"],
      [[MOD, "Enter"], "New ticket dialog: Start planning"],
      [["/"], "Search tickets"],
      [["Esc"], "Clear the search"],
      [["Ctrl", "`"], "Terminal & files panel"],
      [["C"], "Quick Claude chat (no ticket)"],
      [["T"], "Team: teammates, templates, notes"],
      [["?"], "This list"],
      [["Hold", MOD], "Show key hints on buttons"],
    ],
  },
  {
    title: "Cards",
    keys: [
      [["J", "K", "↑", "↓", "←", "→"], "Select a card"],
      [["Enter"], "Open the ticket"],
      [["D"], "Mark done (Review cards)"],
      [["Space"], "Pick up / drop the card"],
      [["↑", "↓", "←", "→"], "Move a picked-up card"],
      [["Esc"], "Cancel the move"],
    ],
  },
  {
    title: "Inbox",
    keys: [
      [["↑", "↓"], "Select an entry"],
      [["Enter"], "Open the ticket (Answer / Open)"],
      [["D"], "Mark done"],
      [["S"], "Snooze for a day / unsnooze"],
    ],
  },
  {
    title: "Ticket panel",
    keys: [
      [["↑", "↓", "K", "J"], "Previous / next ticket"],
      [["Alt", "↑", "↓"], "Previous / next ticket, also while typing"],
      [[MOD, "Shift", "Enter"], "Next step: apply proposal & start work / start work / mark done"],
      [["Enter"], "Send a chat message"],
      [["Shift", "Enter"], "New line"],
      [["E"], "Edit the description"],
      [["R"], "Refine with Claude (Backlog)"],
      [[MOD, "Enter"], "Save the description"],
      [["Esc"], "Cancel the description edit"],
      [[MOD, "\\"], "Show / hide details"],
      [["Esc"], "Close (one layer at a time)"],
    ],
  },
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <div className="form shortcuts">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h4>{g.title}</h4>
            <dl>
              {g.keys.map(([keys, what]) => (
                <div key={what} className="shortcut-row">
                  <dt>{keys.map((k, i) => <kbd key={i}>{k}</kbd>)}</dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}

/** Lower is better; null = no match. Letters must appear in order; word starts and runs score best. */
export const fuzzyScore = (text: string, query: string): number | null => fuzzyMatch(text, query)?.score ?? null;

const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

/** B: type part of a board name, Enter switches. Rows keep the header's board order, so the 1…9 hints match. */
export function BoardSwitcher({ profiles, current, needYou, onPick, onClose }: {
  profiles: Profile[]; current: string | null; needYou: Map<string, number>; onPick: (slug: string) => void; onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const all = profiles.map((p, i) => ({ p, num: i < 9 ? i + 1 : null }));
    if (!q.trim()) return all;
    return all.map((x) => ({ x, s: fuzzyScore(x.p.name, q) ?? fuzzyScore(x.p.slug, q) }))
      .filter((y) => y.s !== null).sort((a, b) => a.s! - b.s!).map((y) => y.x);
  }, [profiles, q]);
  const [active, setActive] = useState(() => Math.max(0, profiles.findIndex((p) => p.slug === current)));
  const pick = (i: number) => shown[i] && onPick(shown[i].p.slug);

  return (
    <Modal title="Switch board" onClose={onClose}>
      <div className="form switcher">
        <input autoFocus value={q} placeholder="Type part of a board name…" aria-label="Board name"
          role="combobox" aria-expanded aria-controls="board-switcher-list" aria-activedescendant={shown[active] ? `bs-${shown[active].p.slug}` : undefined}
          onChange={(e) => { setQ(e.target.value); setActive(0); }}
          onKeyDown={(e) => {
            // 1…9 with nothing typed yet: switch to that board (the number shown on its row), don't search for the digit.
            const digit = !q && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey ? boardDigit(e.nativeEvent.code) : null;
            if (digit !== null) {
              e.preventDefault();
              if (profiles[digit]) onPick(profiles[digit].slug);
              return;
            }
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(shown.length - 1, a + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
            else if (e.key === "Enter") { e.preventDefault(); pick(active); }
          }} />
        <div className="switcher-list" id="board-switcher-list" role="listbox" aria-label="Boards">
          {shown.length === 0 && <div className="picker-empty">No board matches.</div>}
          {shown.map(({ p, num }, i) => {
            const need = needYou.get(p.slug);
            return (
              <div key={p.slug} id={`bs-${p.slug}`} role="option" aria-selected={i === active}
                className={`switcher-item board-switcher-item${i === active ? " active" : ""}`}
                onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(i)}
                ref={(el) => { if (el && i === active) el.scrollIntoView({ block: "nearest" }); }}>
                <span className="profile-avatar" style={{ background: avatarColor(p.slug) }} aria-hidden>{avatarLetter(p.name)}</span>
                <span className="profile-body">
                  <span className="profile-name">{p.name}</span>
                  <span className="profile-path" title={p.path}>{tilde(p.path)}</span>
                </span>
                {!!need && <span className="need-chip">{need} need you</span>}
                {p.slug === current && <span className="profile-check" aria-label="Current board"><CheckIcon size={13} /></span>}
                {num && <kbd aria-label={`Key ${num}`}>{num}</kbd>}
              </div>
            );
          })}
        </div>
        <div className="muted small switcher-foot">
          <span><kbd>↑</kbd> <kbd>↓</kbd> pick</span>
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>1…9</kbd> go to that board</span>
          <span><kbd>[</kbd> <kbd>]</kbd> previous / next board anywhere</span>
        </div>
      </div>
    </Modal>
  );
}
