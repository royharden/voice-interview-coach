import { useState } from "react";
import { SetupScreen } from "@/components/SetupScreen";
import { InterviewRoom } from "@/components/InterviewRoom";
import type { SessionConfig } from "@/lib/types";

type Stage =
  | { name: "setup" }
  | { name: "interview"; config: SessionConfig; demoScript: number | null };

function App() {
  const [stage, setStage] = useState<Stage>({ name: "setup" });

  if (stage.name === "setup") {
    return (
      <SetupScreen
        onStart={(config) => setStage({ name: "interview", config, demoScript: null })}
        onDemo={(config, scriptIndex) => setStage({ name: "interview", config, demoScript: scriptIndex })}
      />
    );
  }

  return (
    <InterviewRoom
      key={stage.config.role + stage.config.interviewType + String(stage.demoScript)}
      config={stage.config}
      demoScript={stage.demoScript}
      onExit={() => setStage({ name: "setup" })}
    />
  );
}

export default App;
