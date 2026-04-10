export default function SymbioticLogo({ size = 64 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 200 200">
      {/* Dark circle background */}
      <circle cx="100" cy="100" r="95" fill="#1a1a1a"/>

      {/* Green slash - top left */}
      <polygon points="95,8 110,55 88,55 75,15" fill="#2ea843"/>

      {/* Orange slash - top right */}
      <polygon points="130,25 175,95 148,95 112,35" fill="#f37920"/>

      {/* Orange-red accent - middle right */}
      <polygon points="155,60 185,110 160,108 140,70" fill="#e8601c"/>

      {/* Yellow slash - bottom center */}
      <polygon points="60,120 125,185 95,190 35,140" fill="#f5c518"/>

      {/* Blue slash - bottom right */}
      <polygon points="100,155 140,185 120,192 85,168" fill="#29a3d5"/>

      {/* Small dark circle dot - right side */}
      <circle cx="188" cy="155" r="10" fill="#1a1a1a"/>
    </svg>
  );
}
