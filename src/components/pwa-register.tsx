"use client";
import { useEffect } from "react";
export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const register = async () => {
      try {
        const response = await fetch("/replica-shell.json", {
            credentials: "omit",
            cache: "no-store",
          }),
          manifest = response.ok ? await response.json() : null;
        if (
          manifest &&
          typeof manifest.version === "string" &&
          /^[a-zA-Z0-9_-]{1,128}$/.test(manifest.version)
        )
          await navigator.serviceWorker.register(
            "/sw.js?build=" + manifest.version,
            { scope: "/", updateViaCache: "none" },
          );
        else if (!(await navigator.serviceWorker.getRegistration("/")))
          await navigator.serviceWorker.register("/sw.js", {
            scope: "/",
            updateViaCache: "none",
          });
      } catch {
        /* Existing code and all device data are kept when an update is unavailable. */
      }
    };
    void register();
    window.addEventListener("online", register);
    return () => window.removeEventListener("online", register);
  }, []);
  return null;
}
