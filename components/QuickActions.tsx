// components/QuickActions.tsx
import React from "react";

const LINKS = [
  { label: "AIChE (or resource 1)", href: "URL_1" },
  { label: "Engineering Toolbox (or resource 2)", href: "URL_2" },
  { label: "Process Safety (or resource 3)", href: "URL_3" },
];

export default function QuickActions() {
  return (
    <div
      className="
        fixed top-4 left-4 z-[9999] 
        flex flex-col gap-2 
        border border-gray-300 rounded-lg bg-white/90 backdrop-blur-sm
        shadow-sm p-2
      "
    >
      {LINKS.map((l) => (
        <a
          key={l.href}
          href={l.href}
          target="_blank"
          rel="noopener noreferrer"
          title={l.label}
          className="
            inline-flex items-center gap-1.5
            px-2 py-1.5 text-sm
            rounded-md shadow 
            font-medium whitespace-nowrap
            bg-blue-600 text-white
            hover:bg-blue-700 hover:shadow-md 
            transition-all
          "
        >
          {/* small SVG icon */}
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M12 2L19 8v6a7 7 0 01-14 0V8l7-6z"
              stroke="white"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>

          <span>{l.label}</span>
        </a>
      ))}
    </div>
  );
}
