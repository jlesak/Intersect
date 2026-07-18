import type { SVGProps } from 'react'

const base = (props: SVGProps<SVGSVGElement>): SVGProps<SVGSVGElement> => ({
  width: 15,
  height: 15,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  ...props
})

export const IconDashboard = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
    <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
    <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
    <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
  </svg>
)

export const IconLayers = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M8 2.5 14 6 8 9.5 2 6z" />
    <path d="M2.5 9.5 8 12.7l5.5-3.2" />
  </svg>
)

export const IconBranch = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="4.5" cy="4" r="1.5" />
    <circle cx="4.5" cy="12" r="1.5" />
    <circle cx="11.5" cy="6" r="1.5" />
    <path d="M4.5 5.5v5M11.5 7.5c0 2.5-3 2-5.5 3" />
  </svg>
)

export const IconPlus = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M8 3v10M3 8h10" />
  </svg>
)

export const IconClose = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
)

export const IconFolder = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
  </svg>
)

export const IconTrash = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M3 4.5h10M6.5 4.5V3.5h3v1M5 4.5l.5 8h5l.5-8" />
  </svg>
)

export const IconPencil = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M11 2.5l2.5 2.5M3 13l1-3.5L11 2.5 13.5 5 6.5 12 3 13z" />
  </svg>
)

export const IconChevronLeft = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M10 3.5L5.5 8l4.5 4.5" />
  </svg>
)

export const IconChevronRight = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M6 3.5L10.5 8 6 12.5" />
  </svg>
)

export const IconShell = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4 5.5L6.5 8 4 10.5M8 10.5h4" />
  </svg>
)

export const IconClaude = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M8 2.5l1.4 3.6L13 7.5l-3.6 1.4L8 12.5 6.6 8.9 3 7.5l3.6-1.4z" />
  </svg>
)

export const IconInbox = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M2.5 9.5L4 3.5h8l1.5 6M2.5 9.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3M2.5 9.5h3l1 2h3l1-2h3" />
  </svg>
)

export const IconHistory = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M2.5 8a5.5 5.5 0 1 1 1.6 3.9M2.5 8V4.5M2.5 8H6M8 5.5V8l2 1.5" />
  </svg>
)

export const IconClock = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v3l2 1.5" />
  </svg>
)

export const IconTodo = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M3 4h2l1 1h6v8H3zM5 8h6M5 10.5h4" />
  </svg>
)

export const IconCalendar = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
    <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
  </svg>
)

export const IconPeople = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="6" cy="6" r="2.3" />
    <circle cx="12" cy="9" r="1.8" />
    <path d="M2.5 13c0-2 1.6-3.3 3.5-3.3s3.5 1.3 3.5 3.3M9.5 13c0-1.4 1-2.4 2.5-2.4s2.5 1 2.5 2.4" />
  </svg>
)

export const IconMyWork = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M2 4h12M2 8h12M2 12h7" />
  </svg>
)

export const IconRefresh = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M13.5 8A5.5 5.5 0 1 1 11.9 4.1M13.5 2v3.5H10" />
  </svg>
)

export const IconLayoutSingle = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="2.5" y="3" width="11" height="10" rx="1" />
  </svg>
)

export const IconLayoutColumns = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="2.5" y="3" width="11" height="10" rx="1" />
    <path d="M8 3v10" />
  </svg>
)

export const IconLayoutRows = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="2.5" y="3" width="11" height="10" rx="1" />
    <path d="M2.5 8h11" />
  </svg>
)

export const IconLayoutGrid = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="2.5" y="3" width="11" height="10" rx="1" />
    <path d="M8 3v10M2.5 8h11" />
  </svg>
)

export const IconFlag = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4 2v12M4 3h8l-2 2.5L12 8H4" />
  </svg>
)

export const IconSettings = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 2v2M8 12v2M2 8h2M12 8h2M3.8 3.8l1.4 1.4M10.8 10.8l1.4 1.4M3.8 12.2l1.4-1.4M10.8 5.2l1.4-1.4" />
  </svg>
)
