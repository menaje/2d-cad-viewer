export type XrefSavedState = "enabled" | "unloaded" | "unresolved";

export interface XrefSavedStateFields {
  xrefLoaded?: boolean;
  xrefResolved?: boolean;
}

export function xrefSavedState({
  xrefLoaded,
  xrefResolved,
}: XrefSavedStateFields): XrefSavedState {
  if (xrefResolved === false) {
    return "unresolved";
  }
  if (xrefLoaded === false) {
    return "unloaded";
  }
  return "enabled";
}

export function xrefShouldLoadAutomatically(
  state: XrefSavedState,
): boolean {
  return state === "enabled";
}
