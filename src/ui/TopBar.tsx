import { PLAYFIELD_SIZES } from '../engine/ToyBoxEngine';
import type { Dict, Lang } from '../i18n';

export function TopBar({
  t,
  lang,
  onToggleLang,
  paused,
  onTogglePause,
  muted,
  onToggleMute,
  onClear,
  scale,
  onScale,
}: {
  t: Dict;
  lang: Lang;
  onToggleLang: () => void;
  paused: boolean;
  onTogglePause: () => void;
  muted: boolean;
  onToggleMute: () => void;
  onClear: () => void;
  scale: number;
  onScale: (scale: number) => void;
}) {
  return (
    <header className="topbar">
      <div className="brand">
        {/* Back to the elnuevos.es home page — the app lives under /toybox, so
            the site root is just "/". */}
        <a className="home" href="/" aria-label={t.home} title={t.home}>
          🏠
        </a>
        <h1 className="brand-title">
          <span aria-hidden>🧰</span> {t.title}
        </h1>
      </div>

      <div className="actions">
        <label className="field" title={t.playfield}>
          <span className="field-icon" aria-hidden>
            ⤢
          </span>
          <select
            className="select"
            aria-label={t.playfield}
            value={scale}
            onChange={(event) => onScale(Number(event.target.value))}
          >
            {PLAYFIELD_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}×
              </option>
            ))}
          </select>
        </label>

        <button
          className={paused ? 'iconbtn on' : 'iconbtn'}
          onClick={onTogglePause}
          aria-label={paused ? t.resume : t.pause}
          title={paused ? t.resume : t.pause}
        >
          {paused ? '▶' : '❚❚'}
        </button>
        <button
          className={muted ? 'iconbtn on' : 'iconbtn'}
          onClick={onToggleMute}
          aria-label={muted ? t.unmute : t.mute}
          title={muted ? t.unmute : t.mute}
        >
          {muted ? '🔇' : '🔊'}
        </button>
        <button className="iconbtn" onClick={onClear} aria-label={t.clear} title={t.clear}>
          🗑
        </button>
        <button className="lang" onClick={onToggleLang} aria-label="language">
          {lang === 'en' ? 'ES' : 'EN'}
        </button>
      </div>
    </header>
  );
}
