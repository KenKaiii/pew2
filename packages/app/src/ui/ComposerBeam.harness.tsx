/** Native-only interactive composer fixture. Not imported by production. */
import { useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { ComposerDock, type ComposerDockHandle } from "./ComposerDock";
import { ConfigPicker } from "./ConfigPicker";
import type { ComposerAnchor, ComposerSelector } from "./Composer";
import type { ConfigOption } from "../useDaemon";
import { theme } from "../theme";
import { ActivityLine } from "./ActivityLine";
import type { Activity, ToolKind } from "../activity";
const KINDS: ToolKind[] = ["search", "read", "think", "fetch", "edit", "move", "execute", "other"];
const TITLES = ["Searching project files", "Reading configuration", "Considering the implementation", "Fetching documentation", "Writing the implementation", "Moving source files", "Running tests", "Working on your request"];

const noop = () => {};
function Screen() {
  const insets = useSafeAreaInsets();
  const composer = useRef<ComposerDockHandle>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Composer preview");
  const [model, setModel] = useState("Auto");
  const [mode, setMode] = useState("Agent");
  const [picker, setPicker] = useState<{kind: string; anchor: ComposerAnchor} | null>(null);
  const [listening, setListening] = useState(false);
  const [activityIndex, setActivityIndex] = useState(0);
  const activity: Activity = {startedAt:1,speaking:false,tools:[{id:String(activityIndex),title:TITLES[activityIndex]!,kind:KINDS[activityIndex]!,status:"in_progress"}]};
  const selectors = useMemo<ComposerSelector[]>(() => [
    { id: "model", value: "Model", label: `Model: ${model}`, onPress: (anchor) => setPicker({kind:"model",anchor}) },
    { id: "mode", value: mode, label: `Mode: ${mode}`, onPress: (anchor) => setPicker({kind:"mode",anchor}) },
  ], [model, mode]);
  const options: ConfigOption[] = picker?.kind === "mode"
    ? [{id:"mode",name:"Mode",type:"select",currentValue:mode,options:[{value:"Agent",name:"Agent"},{value:"Plan",name:"Plan"}]}]
    : [{id:"model",name:"Model",type:"select",currentValue:model,options:[{value:"Auto",name:"Auto"},{value:"Sonnet 4.5",name:"Sonnet 4.5"},{value:"A model with a deliberately very long display name",name:"A model with a deliberately very long display name"}]}];
  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <StatusBar style="light" />
      <View style={[styles.info,{paddingTop:insets.top + 24}]}>
        <Text style={styles.label}>{message}</Text>
        <Text style={styles.hint}>Native preview. Send starts the beam; Stop ends it.</Text>
        <Pressable style={styles.fixture} onPress={() => {composer.current?.setDraft(Array.from({length:12},(_,i)=>`Line ${i+1}: keep the draft visible.`).join("\n")); composer.current?.focus();}}><Text style={styles.label}>Long draft</Text></Pressable>
        <Pressable style={styles.fixture} onPress={() => {setActivityIndex((prev)=>(prev+1)%KINDS.length);setBusy(true);}}><Text style={styles.label}>Next activity</Text></Pressable>
      </View>
      {busy && <ActivityLine activity={activity} />}
      <View style={styles.space} />
      <ComposerDock
        ref={composer} style={{paddingHorizontal:theme.gutter,paddingBottom:insets.bottom + 8}}
        typing={false} showCommands={false} onCommands={noop} onProjectDetails={noop}
        selectors={selectors} busy={busy} onStop={() => {setBusy(false);setMessage("Stopped");}}
        onSend={() => {setMessage("Message sent");setBusy(true);return true;}}
        attachments={[]} onAttach={() => setMessage("Attachment action opened")} onRemoveAttachment={noop}
        dictation={{available:true,listening,toggle:()=>setListening((prev)=>!prev),cancel:()=>setListening(false)}}
      />
      <ConfigPicker visible={!!picker} anchorX={picker?.anchor.x} anchorY={picker?.anchor.y} onClose={()=>setPicker(null)} options={options} onSelect={(id,value)=>{if(typeof value === "string") {if(id === "model") setModel(value);else setMode(value);}}} />
    </KeyboardAvoidingView>
  );
}
export default function ComposerBeamHarness() {
  useEffect(()=>{void SplashScreen.hideAsync();},[]);
  return <SafeAreaProvider><Screen /></SafeAreaProvider>;
}
const styles=StyleSheet.create({
  screen:{flex:1,backgroundColor:theme.color.bg}, info:{paddingHorizontal:theme.gutter,gap:12},
  label:{color:theme.color.text,fontSize:16,lineHeight:21}, hint:{color:theme.color.textDim,fontSize:13,lineHeight:18},
  fixture:{padding:12,backgroundColor:theme.color.surfaceRaised,borderRadius:12,alignSelf:"flex-start"}, space:{flex:1},
});
