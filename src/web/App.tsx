import { useEffect } from "react";
import { useStore } from "./lib/store";
import { Approvals } from "./hud/Approvals";
import { Banner, Faction, Frame, Header, Locked, PermissionsBar, ScoreBar, Toasts, ZoomBox } from "./hud/Chrome";
import { DeployBar, DeployButton } from "./hud/DeployBar";
import { DeployDialog, ManageDialog, ObjectivesBoard, SettingsDialog } from "./hud/Dialogs";
import { IntelPanel } from "./hud/IntelPanel";
import { Roster } from "./hud/Roster";
import { TerminalModal } from "./hud/TerminalModal";
import { useHotkeys, useHudScale } from "./hud/useHotkeys";
import { start } from "./lib/ws";
import { MapView } from "./map/MapView";

export function App() {
  useHudScale();
  useHotkeys();
  useEffect(() => start(), []);
  const intelFull = useStore((s) => s.intelFull && s.selectedAgentId !== null);
  const hasIntel = useStore((s) => s.selectedAgentId !== null);
  const prefs = useStore((s) => s.prefs);
  const hide = [!prefs.labels && "no-labels", !prefs.comms && "no-comms", !prefs.hints && "no-hints", !prefs.decor && "no-decor"].filter(Boolean).join(" ");
  return (
    <div className={`war-room${intelFull ? " intel-full" : ""}${hide ? ` ${hide}` : ""}`}>
      <MapView />
      <Frame />
      <Header />
      <ScoreBar />
      <Faction />
      <Roster />
      <ZoomBox />
      <PermissionsBar />
      <Banner />
      <Approvals />
      <DeployBar />
      <div className={`right-col${hasIntel ? " has-intel" : ""}`}>
        <IntelPanel />
        <DeployButton />
      </div>
      <DeployDialog />
      <ManageDialog />
      <ObjectivesBoard />
      <SettingsDialog />
      <TerminalModal />
      <Toasts />
      <Locked />
    </div>
  );
}
