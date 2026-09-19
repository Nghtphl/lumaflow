import { clsx } from "clsx";
import type { ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge Tailwind classes so a caller's `className` always wins over a
 * component's defaults instead of losing to whichever rule CSS ordering
 * happened to emit last.
 */
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
