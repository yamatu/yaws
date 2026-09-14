import { ClipboardPaste, ChevronDown } from "lucide-react";
import {
  BACKSPACE_KEY,
  ENTER_KEY,
  NAV_KEYS,
  SCROLL_KEYS,
  type KeyButton,
  type Mods,
} from "./terminalKeys";

/**
 * Key bar under the terminal. Buttons keep focus in the terminal (pointerdown is
 * prevented) so the soft keyboard does not close when a key is tapped.
 */
export function MobileKeyBar({
  mods,
  onMod,
  onSend,
  onPaste,
  onHide,
  disabled,
}: {
  mods: Mods;
  onMod: (mods: Mods) => void;
  onSend: (key: KeyButton) => void;
  onPaste: () => void;
  onHide: () => void;
  disabled: boolean;
}) {
  const modButton = (name: "ctrl" | "alt", label: string) => (
    <button
      type="button"
      className="keybar-key keybar-mod"
      aria-label={name === "ctrl" ? "Ctrl 组合键" : "Alt 组合键"}
      aria-pressed={mods[name]}
      title={
        name === "ctrl"
          ? "点一下再按字母，等于 Ctrl+字母"
          : "点一下再按字符，等于 Alt+字符"
      }
      disabled={disabled}
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => onMod({ ...mods, [name]: !mods[name] })}
    >
      {label}
    </button>
  );
  return (
    <div className="mobile-keybar" role="toolbar" aria-label="终端按键">
      <div className="keybar-row">
        {modButton("ctrl", "Ctrl")}
        {modButton("alt", "Alt")}
        {NAV_KEYS.map((key) => (
          <button
            key={key.label}
            type="button"
            className="keybar-key"
            aria-label={key.aria ?? key.label}
            disabled={disabled}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => onSend(key)}
          >
            {key.label}
          </button>
        ))}
        <button
          type="button"
          className="keybar-key keybar-icon"
          aria-label="粘贴"
          title="粘贴剪贴板内容"
          disabled={disabled}
          onPointerDown={(e) => e.preventDefault()}
          onClick={onPaste}
        >
          <ClipboardPaste size={15} />
        </button>
        <button
          type="button"
          className="keybar-key keybar-icon"
          aria-label="收起按键栏"
          title="收起按键栏"
          onPointerDown={(e) => e.preventDefault()}
          onClick={onHide}
        >
          <ChevronDown size={16} />
        </button>
      </div>
      <div className="keybar-row keybar-scroll">
        {SCROLL_KEYS.map((key) => (
          <button
            key={`${key.label}:${key.seq}`}
            type="button"
            className={`keybar-key${key.plain ? " keybar-symbol" : ""}`}
            aria-label={key.aria ?? key.label}
            disabled={disabled}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => onSend(key)}
          >
            {key.label}
          </button>
        ))}
        <button
          type="button"
          className="keybar-key"
          aria-label={BACKSPACE_KEY.aria}
          disabled={disabled}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => onSend(BACKSPACE_KEY)}
        >
          {BACKSPACE_KEY.label}
        </button>
        <button
          type="button"
          className="keybar-key keybar-enter"
          aria-label={ENTER_KEY.aria}
          disabled={disabled}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => onSend(ENTER_KEY)}
        >
          {ENTER_KEY.label}
        </button>
      </div>
    </div>
  );
}
