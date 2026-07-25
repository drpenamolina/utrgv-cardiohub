import { useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "./firebase";
import SalinasCardio from "./SalinasCardio";

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = loading, null = signed out

  useEffect(() => onAuthStateChanged(auth, setUser), []);

  if (user === undefined) {
    return <div style={styles.center}>Loading…</div>;
  }

  return <SalinasCardio user={user} />;
}

const styles = {
  center: { minHeight: "100vh", display: "grid", placeItems: "center", background: "#12232C", fontFamily: "system-ui, sans-serif", color: "#fff" },
};
