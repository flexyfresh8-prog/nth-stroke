'use client';
import { useEffect, useState } from 'react';
import Studio from './Studio';
import StructuralStudio from './StructuralStudio';
export type Version = 'v1' | 'v2' | 'v3';
export default function Workspace() {
  const [version, setVersion] = useState<Version | null>(null),
    [file, setFile] = useState<File | null>(null),
    [project, setProject] = useState<File | null>(null);
  useEffect(() => {
    let id: Version = 'v3';
    try {
      const p = localStorage.getItem('nth-engine');
      if (p === 'v1' || p === 'v2') id = p;
    } catch {}
    setVersion(id);
  }, []);
  function choose(v: Version) {
    setVersion(v);
    setProject(null);
    try {
      localStorage.setItem('nth-engine', v);
    } catch {}
  }
  async function open(f: File) {
    const head = await f.slice(0, 5).text();
    if (head === 'NTH3\n') {
      choose('v3');
      setProject(f);
    } else {
      choose('v2');
      setProject(f);
    }
  }
  if (!version) return null;
  return version === 'v3' ? (
    <StructuralStudio
      file={file}
      project={project}
      select={choose}
      importFile={(f) => {
        setProject(null);
        setFile(f);
      }}
      restoredFile={setFile}
      open={open}
    />
  ) : (
    <Studio
      initial={version}
      sharedFile={file}
      sharedProject={project}
      selectVersion={choose}
      shareFile={setFile}
      openAny={open}
    />
  );
}
