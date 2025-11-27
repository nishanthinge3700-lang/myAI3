// components/QuickActions.tsx
import React from "react";

const LINKS = [
  { label: "Steam Tables", href: "https://pages.mtu.edu/~tbco/cm3230/steamtables.pdf" },
  { label: "ChemEng Toolbox", href: "https://www.engineeringtoolbox.com/" },
  { label: "Materials Safety", href: "https://pubchem.ncbi.nlm.nih.gov/" },
];

export default function QuickActions() {
  return (
    <div
      className="
        fixed top-22 left-4 z-[9999] 
        flex flex-col gap-2 
        border border-gray-300 rounded-lg bg-white/90 backdrop-blur-sm
        shadow-sm p-2 max-w-[200x]
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
  
         

          <span>{l.label}</span>
        </a>
      ))}
    </div>
  );
}


