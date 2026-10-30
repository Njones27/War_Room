import { useEffect } from "react";
import { useStore } from "./lib/store";
import { Approvals } from "./hud/Approvals";
import { Banner, Faction, Frame, Header, Locked, PermissionsBar, ScoreBar, Toasts, ZoomBox } from "./hud/Chrome";
import { DeployBar, DeployButton } from "./hud/DeployBar";
import { DeployDialog, LaunchDialog, ManageDialog, ObjectivesBoard, SettingsDialog } from "./hud/Dialogs";
import { IntelPanel } from "./hud/IntelPanel";
import { SatellitePanel } from "./hud/SatellitePanel";
import { Roster } from "./hud/Roster";
import { TerminalModal } from "./hud/TerminalModal";
import { useHotkeys, useHudScale } from "./hud/useHotkeys";
import { start } from "./lib/ws";
import { MapView } from "./map/MapView";
import { OrbitView } from "./map/OrbitView";

export function App() {
  useHudScale();
  useHotkeys();
  useEffect(() => start(), []);
  const intelFull = useStore((s) => s.intelFull && s.selectedAgentId !== null);
  const orbit = useStore((s) => s.view === "orbit");
  const hasIntel = useStore((s) => s.selectedAgentId !== null || (s.view === "orbit" && s.selectedSatelliteId !== null));
  const prefs = useStore((s) => s.prefs);
  const hide = [!prefs.labels && "no-labels", !prefs.comms && "no-comms", !prefs.hints && "no-hints", !prefs.decor && "no-decor"].filter(Boolean).join(" ");
  return (
    <div className={`war-room${intelFull ? " intel-full" : ""}${orbit ? " in-orbit" : ""}${hide ? ` ${hide}` : ""}`}>
      <MapView />
      <OrbitView />
      <Frame />
      <Header />
      <ScoreBar />
      <Faction />
      <Roster />
      <ZoomBox />
      <PermissionsBar />
      <Banner />
      <Approvals />
      {!orbit && <DeployBar />}
      <div className={`right-col${hasIntel ? " has-intel" : ""}`}>
        {orbit ? <SatellitePanel /> : <IntelPanel />}
        <DeployButton />
      </div>
      <DeployDialog />
      <ManageDialog />
      <ObjectivesBoard />
      <SettingsDialog />
      <LaunchDialog />
      <TerminalModal />
      <Toasts />
      <Locked />
    </div>
  );
}
