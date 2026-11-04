// Tiny EN/ES dictionary, auto-detected from the browser, with a toggle.
// Same approach as the sibling apps on elnuevos.es.

export type Lang = 'en' | 'es';

export const STRINGS = {
  en: {
    title: 'ToyBox',
    subtitle: 'A box of little physics toys',
    home: 'Home',
    hint: 'Pick a toy below, then click the box to drop it in. Drag anything to move it.',
    tools: 'Tools',
    drag: 'Grab',
    remove: 'Remove',
    clear: 'Clear',
    pause: 'Pause',
    resume: 'Resume',
    paused: 'Paused',
    mute: 'Mute',
    unmute: 'Unmute',
    empty: 'The box is empty',
    emptyHint: 'Pick a toy from the palette below to drop it in.',
    count: '{n} toys',
    group_balls: 'Balls',
    group_blocks: 'Blocks',
    group_belts: 'Belts',
    group_music: 'Music',
    toy_ballBouncy: 'Bouncy',
    toy_ballMarble: 'Marble',
    toy_ballHeavy: 'Cannonball',
    toy_ballBeach: 'Beach ball',
    toy_crate: 'Crate',
    toy_plank: 'Plank',
    toy_ramp: 'Ramp',
    toy_glass: 'Glass',
    toy_brick: 'Brick',
    toy_beltRight: 'Right',
    toy_beltLeft: 'Left',
    toy_noteBlock: 'Note',
  },
  es: {
    title: 'ToyBox',
    subtitle: 'Una caja de pequeños juguetes de física',
    home: 'Inicio',
    hint: 'Elige un juguete abajo y haz clic en la caja para dejarlo caer. Arrastra cualquier cosa para moverla.',
    tools: 'Herramientas',
    drag: 'Coger',
    remove: 'Borrar',
    clear: 'Vaciar',
    pause: 'Pausa',
    resume: 'Reanudar',
    paused: 'En pausa',
    mute: 'Silenciar',
    unmute: 'Sonido',
    empty: 'La caja está vacía',
    emptyHint: 'Elige un juguete de la paleta para dejarlo caer.',
    count: '{n} juguetes',
    group_balls: 'Pelotas',
    group_blocks: 'Bloques',
    group_belts: 'Cintas',
    group_music: 'Música',
    toy_ballBouncy: 'Saltarina',
    toy_ballMarble: 'Canica',
    toy_ballHeavy: 'Balón',
    toy_ballBeach: 'Playa',
    toy_crate: 'Caja',
    toy_plank: 'Tabla',
    toy_ramp: 'Rampa',
    toy_glass: 'Cristal',
    toy_brick: 'Ladrillo',
    toy_beltRight: 'Derecha',
    toy_beltLeft: 'Izquierda',
    toy_noteBlock: 'Nota',
  },
} as const;

// Widen literal string values to `string` so EN and ES share one shape.
export type Dict = { [K in keyof (typeof STRINGS)['en']]: string };

export function detectLang(): Lang {
  const nav = (
    navigator.language ||
    (navigator.languages && navigator.languages[0]) ||
    'en'
  ).toLowerCase();
  return nav.startsWith('es') ? 'es' : 'en';
}

/** Look up a key that is only known at runtime (toy ids, group titles). */
export function pick(dict: Dict, key: string): string {
  return (dict as Record<string, string>)[key] ?? key;
}

/** Fill `{name}` placeholders, e.g. `format(t.count, { n: 3 })`. */
export function format(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  );
}
