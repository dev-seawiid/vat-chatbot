import { Instrument_Serif, JetBrains_Mono } from "next/font/google";

// Display — Instrument Serif italic. 라틴 강조어("대답", "ASK") 전용.
const instrument = Instrument_Serif({
  variable: "--font-instrument",
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal", "italic"],
  display: "swap",
});

// Mono — JetBrains Mono. 라벨/메타/카운터/CTA caps.
const jet = JetBrains_Mono({
  variable: "--font-jet",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const fontVariables = `${instrument.variable} ${jet.variable}`;
