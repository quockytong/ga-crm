import type { CSSProperties, ReactElement } from "react";

type BrandProps = { className?: string; style?: CSSProperties };
/** "logo daiichi life 2026" = horizontal (220x40), "logo dlvn" = stacked. */
export function Logo(props?: BrandProps & { state?: "logo daiichi life 2026" | "logo dlvn" }): ReactElement;
/** The top gradient strip (16px high). */
export function FutureLine(props?: BrandProps): ReactElement;
