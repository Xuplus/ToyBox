import type { Tool } from '../engine/ToyBoxEngine';
import { pick, type Dict } from '../i18n';
import { shade } from '../lib/color';
import { PALETTE_GROUPS, toyById } from '../toys/catalog';

function swatch(shape: string, color: string): string {
  const light = shade(color, 0.45);
  const dark = shade(color, -0.28);
  if (shape === 'circle') {
    return `radial-gradient(circle at 35% 30%, ${light}, ${color} 62%, ${dark})`;
  }
  return `linear-gradient(180deg, ${light}, ${color} 55%, ${dark})`;
}

export function Palette({
  t,
  tool,
  onSelect,
}: {
  t: Dict;
  tool: Tool;
  onSelect: (tool: Tool) => void;
}) {
  return (
    <div className="palette">
      <div className="group">
        <span className="group-title">{t.tools}</span>
        <div className="group-row">
          <button
            className={tool === 'drag' ? 'chip active' : 'chip'}
            onClick={() => onSelect('drag')}
            title={t.drag}
          >
            <span className="tool-icon" aria-hidden>
              ✋
            </span>
            {t.drag}
          </button>
          <button
            className={tool === 'delete' ? 'chip active' : 'chip'}
            onClick={() => onSelect('delete')}
            title={t.remove}
          >
            <span className="tool-icon" aria-hidden>
              ✖
            </span>
            {t.remove}
          </button>
        </div>
      </div>

      <div className="palette-divider" aria-hidden />

      {PALETTE_GROUPS.map((group) => (
        <div className="group" key={group.titleKey}>
          <span className="group-title">{pick(t, group.titleKey)}</span>
          <div className="group-row">
            {group.ids.map((id) => {
              const toy = toyById(id);
              if (!toy) return null;
              const label = pick(t, toy.nameKey);
              return (
                <button
                  key={id}
                  className={tool === id ? 'chip active' : 'chip'}
                  onClick={() => onSelect(id)}
                  title={label}
                >
                  <span
                    className={`swatch ${toy.swatch}`}
                    style={{ background: swatch(toy.swatch, toy.color) }}
                    aria-hidden
                  />
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
