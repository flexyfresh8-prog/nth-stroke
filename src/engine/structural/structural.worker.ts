import { driver } from './driver';
const receive = driver((message) => self.postMessage(message));
self.onmessage = (event) => void receive(event.data);
