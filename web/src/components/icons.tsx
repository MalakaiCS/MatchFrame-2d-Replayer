/* Original Matchframe icon set: simple geometric strokes, 16px grid. */
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { title?: string };

function Svg({ title, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? "img" : undefined} {...rest}>
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export const IconPlay = (p: P) => <Svg {...p}><path d="M5 3.5v9l7-4.5z" fill="currentColor" stroke="none" /></Svg>;
export const IconPause = (p: P) => <Svg {...p}><path d="M5.5 3.5v9M10.5 3.5v9" strokeWidth="2.2" /></Svg>;
export const IconPrevRound = (p: P) => <Svg {...p}><path d="M4 3.5v9M12 3.5 6.5 8l5.5 4.5z" /></Svg>;
export const IconNextRound = (p: P) => <Svg {...p}><path d="M12 3.5v9M4 3.5 9.5 8 4 12.5z" /></Svg>;
export const IconBack = (p: P) => <Svg {...p}><path d="M8 4 4 8l4 4M12 4 8 8l4 4" /></Svg>;
export const IconForward = (p: P) => <Svg {...p}><path d="m4 4 4 4-4 4M8 4l4 4-4 4" /></Svg>;
export const IconPrevEvent = (p: P) => <Svg {...p}><path d="M10 4 6 8l4 4" /><circle cx="3.5" cy="8" r="1" fill="currentColor" /></Svg>;
export const IconNextEvent = (p: P) => <Svg {...p}><path d="m6 4 4 4-4 4" /><circle cx="12.5" cy="8" r="1" fill="currentColor" /></Svg>;
export const IconZoomIn = (p: P) => <Svg {...p}><circle cx="7" cy="7" r="4.5" /><path d="M7 5v4M5 7h4M10.5 10.5 14 14" /></Svg>;
export const IconZoomOut = (p: P) => <Svg {...p}><circle cx="7" cy="7" r="4.5" /><path d="M5 7h4M10.5 10.5 14 14" /></Svg>;
export const IconFit = (p: P) => <Svg {...p}><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" /></Svg>;
export const IconFollow = (p: P) => <Svg {...p}><circle cx="8" cy="8" r="2.2" /><path d="M8 1.5v2.5M8 12v2.5M1.5 8H4M12 8h2.5" /></Svg>;
export const IconLayers = (p: P) => <Svg {...p}><path d="m8 2.5 6 3-6 3-6-3zM2 10.5l6 3 6-3" /></Svg>;
export const IconShare = (p: P) => <Svg {...p}><circle cx="4" cy="8" r="1.8" /><circle cx="12" cy="4" r="1.8" /><circle cx="12" cy="12" r="1.8" /><path d="m5.6 7.1 4.8-2.3M5.6 8.9l4.8 2.3" /></Svg>;
export const IconBookmark = (p: P) => <Svg {...p}><path d="M4.5 2.5h7v11L8 11l-3.5 2.5z" /></Svg>;
export const IconNote = (p: P) => <Svg {...p}><path d="M3 2.5h7l3 3v8H3zM10 2.5v3h3M5.5 8.5h5M5.5 11h3.5" /></Svg>;
export const IconList = (p: P) => <Svg {...p}><path d="M5.5 4h8M5.5 8h8M5.5 12h8" /><circle cx="2.5" cy="4" r=".8" fill="currentColor" /><circle cx="2.5" cy="8" r=".8" fill="currentColor" /><circle cx="2.5" cy="12" r=".8" fill="currentColor" /></Svg>;
export const IconAudio = (p: P) => <Svg {...p}><path d="M2.5 6v4h2.5l3.5 3V3L5 6zM11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.5a6 6 0 0 1 0 9" /></Svg>;
export const IconUsers = (p: P) => <Svg {...p}><circle cx="6" cy="5.5" r="2.3" /><path d="M2 13c.5-2.3 2-3.5 4-3.5s3.5 1.2 4 3.5M10.5 3.5a2.2 2.2 0 0 1 0 4.2M12 9.7c1.2.5 1.9 1.6 2.1 3.3" /></Svg>;
export const IconBolt = (p: P) => <Svg {...p}><path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z" /></Svg>;
export const IconUpload = (p: P) => <Svg {...p}><path d="M8 10.5V2.5M4.5 6 8 2.5 11.5 6M2.5 10.5v3h11v-3" /></Svg>;
export const IconTrash = (p: P) => <Svg {...p}><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9" /></Svg>;
export const IconEdit = (p: P) => <Svg {...p}><path d="m10.5 2.5 3 3-8 8h-3v-3z" /></Svg>;
export const IconUp = (p: P) => <Svg {...p}><path d="m4 10 4-4 4 4" /></Svg>;
export const IconDown = (p: P) => <Svg {...p}><path d="m4 6 4 4 4-4" /></Svg>;
export const IconKeyboard = (p: P) => <Svg {...p}><rect x="1.5" y="4" width="13" height="8" rx="1.5" /><path d="M4 7h.01M6.5 7h.01M9 7h.01M11.5 7h.01M5 9.5h6" /></Svg>;
export const IconClose = (p: P) => <Svg {...p}><path d="m4 4 8 8M12 4l-8 8" /></Svg>;
export const IconLink = (p: P) => <Svg {...p}><path d="M6.5 9.5 9.5 6.5M7 4.5l1.2-1.2a2.8 2.8 0 0 1 4 4L11 8.5M9 11.5l-1.2 1.2a2.8 2.8 0 0 1-4-4L5 7.5" /></Svg>;

export function Wordmark() {
  return (
    <svg className="wordmark-mark" viewBox="0 0 22 22" aria-hidden="true">
      <rect x="1" y="1" width="20" height="20" rx="4" fill="none" stroke="#d6dde6" strokeWidth="1.6" />
      <path d="M5 15V7l3.5 5L12 7v8" fill="none" stroke="#d6dde6" strokeWidth="1.8" strokeLinejoin="round" />
      <circle cx="16" cy="9" r="1.7" fill="#38c6e8" />
      <path d="m16 12.3 1.9 3.2h-3.8z" fill="#f2a93b" />
    </svg>
  );
}
