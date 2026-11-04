import { useCallback, useEffect, useRef, useState } from 'react';
import { Synth } from './audio/synth';
import { ToyBoxEngine, type Tool } from './engine/ToyBoxEngine';
import { STRINGS, detectLang, format, type Lang } from './i18n';
import { Palette } from './ui/Palette';
import { TopBar } from './ui/TopBar';

export default function App() {
  const [lang, setLang] = useState<Lang>(detectLang);
  const [tool, setTool] = useState<Tool>('drag');
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(false);
  const [count, setCount] = useState({ toys: 0, bodies: 0 });
  const [hint, setHint] = useState(true);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<ToyBoxEngine | null>(null);
  const t = STRINGS[lang];

  // Mount the engine once. State changes go through the ref, never a rebuild —
  // recreating the world would throw away everything in the box.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const engine = new ToyBoxEngine(canvas, new Synth(), {
      onCount: (toys, bodies) => setCount({ toys, bodies }),
      onFirstInteraction: () => setHint(false),
    });
    engineRef.current = engine;

    let seeded = false;
    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      engine.resize(rect.width, rect.height);
      if (!seeded) {
        seeded = true;
        engine.seed();
      }
    };

    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    measure();
    engine.start();

    return () => {
      observer.disconnect();
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.setTool(tool);
  }, [tool]);

  useEffect(() => {
    engineRef.current?.setPaused(paused);
  }, [paused]);

  useEffect(() => {
    engineRef.current?.setMuted(muted);
  }, [muted]);

  // Escape always returns to the grab tool.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTool('drag');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The hint is a nudge, not furniture — retire it even if nobody clicks.
  useEffect(() => {
    const id = window.setTimeout(() => setHint(false), 9000);
    return () => window.clearTimeout(id);
  }, []);

  const togglePause = useCallback(() => setPaused((value) => !value), []);
  const toggleMute = useCallback(() => setMuted((value) => !value), []);
  const toggleLang = useCallback(() => setLang((value) => (value === 'en' ? 'es' : 'en')), []);
  const clear = useCallback(() => {
    engineRef.current?.clear();
    setHint(false);
  }, []);

  return (
    <div className="app">
      <TopBar
        t={t}
        lang={lang}
        onToggleLang={toggleLang}
        paused={paused}
        onTogglePause={togglePause}
        muted={muted}
        onToggleMute={toggleMute}
        onClear={clear}
      />

      <main className="stage">
        <canvas ref={canvasRef} className="board" />

        {hint && !paused && <div className="hint">{t.hint}</div>}
        {paused && <div className="paused-pill">{t.paused}</div>}

        {count.bodies === 0 && (
          <div className="empty">
            <strong>{t.empty}</strong>
            <span>{t.emptyHint}</span>
          </div>
        )}

        <div className="counter">{format(t.count, { n: count.toys })}</div>
      </main>

      <Palette t={t} tool={tool} onSelect={setTool} />
    </div>
  );
}
