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
}: {
  t: Dict;
  lang: Lang;
  onToggleLang: () => void;
  paused: boolean;
  onTogglePause: () => void;
  muted: boolean;
  onToggleMute: () => void;
  onClear: () => void;
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
