export type XrefSavedState = "enabled" | "unloaded" | "unresolved";

export interface XrefSavedStateFields {
  xrefLoaded?: boolean;
  xrefResolved?: boolean;
}

export function xrefSavedState({
  xrefLoaded,
  xrefResolved,
}: XrefSavedStateFields): XrefSavedState {
  if (xrefLoaded === false) {
    return "unloaded";
  }
  if (xrefResolved === false) {
    return "unresolved";
  }
  return "enabled";
}

export function xrefShouldLoadAutomatically(
  state: XrefSavedState,
): boolean {
  return state === "enabled";
}
