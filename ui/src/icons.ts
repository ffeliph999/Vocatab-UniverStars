// 自前のアイコン（16×16、線は currentColor）。

const svg = (body: string): string =>
  `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" ` +
  `stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS: Record<string, string> = {
  play: svg('<path d="M5 3.5v9l7-4.5z" fill="currentColor" stroke="none"/>'),
  pause: svg('<path d="M5 3.5v9M11 3.5v9" stroke-width="2.2"/>'),
  stop: svg('<rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none"/>'),
  loop: svg('<path d="M3 7a4 4 0 0 1 4-3h5M10 2l2 2-2 2M13 9a4 4 0 0 1-4 3H4M6 14l-2-2 2-2"/>'),
  follow: svg('<path d="M3 8h8M8 5l3 3-3 3M13 3v10"/>'),
  select: svg('<path d="M4 2.5l8 5-3.6.9 2.2 4.3-1.6.8-2.2-4.3L4 11.6z"/>'),
  draw: svg('<path d="M3 13l1-3.5 6.5-6.5 2.5 2.5L6.5 12z M9.5 4l2.5 2.5"/>'),
  pitchpen: svg('<path d="M1.5 11c2-5 3.5-5 5 0s3 5 4.5 0"/><path d="M12 2.5l1.5 1.5-3 3-1.8.3.3-1.8z"/>'),
  showpitch: svg('<path d="M1.5 10c2.5-6 4-6 6.5-1s4 5 6.5-1"/>'),
  showphone: svg('<path d="M2.5 4h11M2.5 8h7M2.5 12h9"/>'),
  sidebar: svg('<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M6 2.5v11"/>'),
  showwave: svg('<path d="M2 8h.5M4.5 5.5v5M7 3v10M9.5 5v6M12 6.5v3M14 8h.5"/>'),
  voice: svg('<rect x="5.5" y="2" width="5" height="8" rx="2.5"/><path d="M3.5 8a4.5 4.5 0 0 0 9 0M8 12.5V14"/>'),
  note: svg('<path d="M6 12V3.5l7-1.5V10.5"/><circle cx="4.5" cy="12" r="1.8"/><circle cx="11.5" cy="10.5" r="1.8"/>'),
  render: svg('<path d="M2 9h2l1.5-4 2.5 8 2-6 1.5 2H14"/>'),
  fx: svg('<path d="M2.5 4.5v7M2.5 6.5h0M8 4.5v7M13.5 4.5v7"/><circle cx="2.5" cy="9" r="1.4"/><circle cx="8" cy="6" r="1.4"/><circle cx="13.5" cy="10" r="1.4"/>'),
  settings: svg('<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>'),
  phoneme: svg('<path d="M3 12V5a2.5 2.5 0 0 1 5 0v7M3 8.5h5M10 12V4h1.5a2 2 0 0 1 0 4H10"/>'),
  param: svg('<path d="M1.5 11c3 0 3-6 6.5-6s3.5 6 6.5 6"/>'),
  line: svg('<circle cx="3.5" cy="12.5" r="1.6"/><circle cx="12.5" cy="3.5" r="1.6"/><path d="M4.7 11.3l6.6-6.6"/>'),
  eraser: svg('<path d="M6 13.5h7.5M2.8 9.8l6-6a1.5 1.5 0 0 1 2.1 0l2.3 2.3a1.5 1.5 0 0 1 0 2.1L8 13.5H5.5z"/>'),
  swap: svg('<path d="M2.5 5.5h10M10 3l2.5 2.5L10 8M13.5 10.5h-10M6 8l-2.5 2.5L6 13"/>'),
  export: svg('<path d="M8 2.5v7.5M5 7l3 3 3-3M3 12.5h10"/>'),
  mel: svg('<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M4.5 11V8M7 11V5.5M9.5 11V7M12 11V9"/>'),
};
