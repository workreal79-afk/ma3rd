import { useCallback, useState } from "react";

export function useRefreshKey() {
  const [value, setValue] = useState(0);
  const refresh = useCallback(() => setValue((current) => current + 1), []);
  return [value, refresh];
}
