import { useEffect } from "react";
import { useStore } from "./lib/store";
import { Approvals } from "./hud/Approvals";
import { Banner, Faction, Frame, Header, Locked, PermissionsBar, ScoreBar, Toasts, ZoomBox } from "./hud/Chrome";
import { DeployBar, DeployButton } from "./hud/DeployBar";
import { DeployDialog, ManageDialog, ObjectivesBoard } from "./hud/Dialogs";
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
  return (
    <div className={`war-room${intelFull ? " intel-full" : ""}`}>
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
      <div className="right-col">
        <IntelPanel />
        <DeployButton />
      </div>
      <DeployDialog />
      <ManageDialog />
      <ObjectivesBoard />
      <TerminalModal />
      <Toasts />
      <Locked />
    </div>
  );
}
