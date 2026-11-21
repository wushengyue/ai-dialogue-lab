// Page content stays still. Loading feedback belongs to the teacher's hair.
const $ = id => document.getElementById(id);
export function stopBoardCamera() { $('blackboard').dataset.camera='idle'; }
export function prepareBoardCamera() { stopBoardCamera(); }
export function settleBoardCamera() { stopBoardCamera(); }
export function enterBoardPage() { stopBoardCamera(); }
