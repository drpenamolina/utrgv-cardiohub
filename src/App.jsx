import { useEffect, useState } from "react";
import { onAuthStateChanged, isSignInWithEmailLink, signInWithEmailLink } from "firebase/auth";
import { auth } from "./firebase";
import SalinasCardio from "./SalinasCardio";

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = loading, null = signed out

  useEffect(() => {
    if (isSignInWithEmailLink(auth, window.location.href)) {
      const email = window.localStorage.getItem("emailForSignIn") || window.prompt("Confirm your email to finish signing in");
      if (email) {
        signInWithEmailLink(auth, email, window.location.href)
          .then(() => window.localStorage.removeItem("emailForSignIn"))
          .catch((err) => console.error("Email link sign-in failed:", err))
          .finally(() => window.history.replaceState({}, document.title, window.location.pathname));
      }
    }
  }, []);

  useEffect(() => onAuthStateChanged(auth, setUser), []);

  if (user === undefined) {
    return <div style={styles.center}>Loading…</div>;
  }

  return <SalinasCardio user={user} />;
}

const styles = {
  center: { minHeight: "100vh", display: "grid", placeItems: "center", background: "#12232C", fontFamily: "system-ui, sans-serif", color: "#fff" },
};
