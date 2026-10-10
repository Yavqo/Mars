/** SafeSearch is on by default. Only an explicit "off" cookie turns it off. */
export const safeFrom = (cookie: string | undefined) => cookie !== "off";
