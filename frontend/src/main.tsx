import { createRoot } from "react-dom/client";
import Dashboard from "@/components/argon/Dashboard";
import "../app/globals.css";

const container = document.getElementById("root");
if (!container) throw new Error("The application root is missing.");
createRoot(container).render(<Dashboard />);
