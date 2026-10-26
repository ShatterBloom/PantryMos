// Mos, drawn in lines: the brand mark, the face beside Mos's messages, and the empty chat. The antenna
// light shows when Mos is listening; the eyes move while Mos is thinking.

export type RobotState = 'idle' | 'thinking' | 'listening';

export function Robot({ size = 24, state = 'idle' }: { size?: number; state?: RobotState }) {
  return (
    <svg
      className={`robot robot-${state}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle className="robot-led" cx="12" cy="2.9" r="1.3" />
      <path d="M12 4.2V6.5" />
      <rect x="4.5" y="6.5" width="15" height="13" rx="4" />
      <path d="M4.5 11.5H3v4h1.5M19.5 11.5H21v4h-1.5" />
      <g className="robot-eyes">
        <circle cx="9.5" cy="12.3" r="1.1" fill="currentColor" stroke="none" />
        <circle cx="14.5" cy="12.3" r="1.1" fill="currentColor" stroke="none" />
      </g>
      <path d="M10 16.1q2 1.2 4 0" />
    </svg>
  );
}
