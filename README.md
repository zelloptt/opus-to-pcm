Opus to PCM
-----------
If we want to decode raw opus packet to PCM in our browsers, there are two ways to do that:

 1. Using [libopus](https://opus-codec.org/) decoder of javascript version that can be ported using Emscripten.
 2. Using the Web Audio API method [decodeAudioData](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData)

First approach is very straight forward but it needs to carry a big size decoder js file (approx. 900KB) and it is very resource expensive that become difficult to handle for the browsers that are running on low resource like mobile devices.

Second approach is the best way but unfortunately **decodeAudioData** fails to decode raw opus packet. Actually it expects Ogg bitstream instead of raw opus packet. This project basically does that thing. It encapsulate raw opus packet into ogg packet on the fly so that decodeAudioData can decode to PCM data. One problem with this approach is that opus is supported by all browsers till today e.g. Safari so libopus is included as a fallback.

**How to use?**

    var decoder = new Decoder.OpusToPCM(option);

Available options are:

*channels* - no of channels in opus data

*fallback* - true/false. Whether it will use libopus as fallback or not. Default is true.

*useNative* - true/false. Opt in to a native decoder path backed by the browser's [WebCodecs `AudioDecoder`](https://developer.mozilla.org/en-US/docs/Web/API/AudioDecoder) instead of the libopus-in-worker bundle. Default is false. When `useNative: true` is set on an environment that doesn't provide `AudioDecoder`, the decoder falls back to libopus iff `fallback: true`. Recommended for Chromium-based environments where `AudioDecoder` + `codec: 'opus'` is guaranteed by spec and avoids the ~900KB inlined worker bundle entirely.

Decoder fire an event *decode* whenever it completes decoding. Usually it decodes several opus packet at a time for better performance although it need to be provided single opus packet into *decode* method.

**Complete example:**

    var decoder = new Decoder.OpusToPCM({
	  channels: 1,
	  fallback: true 
    });
    decoder.on('decode', function(pcmData) {
         //do whatever you want to do with PCM data
    });
    
    // single opus packet and it is a typedArray
    decoder.decode(opus_packet); 

**Available Methods**

| Name        | Parameter           | Remark  |
| ------------- |:-------------:| -----:|
| getSampleRate      | - | It return output sample rate of the PCM data |
| decode      | data TypedArray      |  Decode provided opus packet to PCM  |
| destroy | -      |    Destroy the decoder instance and release the resources |
  
 **Compatibility**
 
   it is supported on:

 * Chrome for Android 34+
 * Chrome for Desktop 34+
 * Firefox for Android 41+
 * Firefox for Desktop 42+
 * IE11+ for Windows 8.1+ (fallback)
 * Edge for Windows 10+
 * Opera for Desktop
 * Safari for Mac 8+ (fallback)

**How to run example?**

An example with simple node server script is available that include some raw opus packets that will be served by websocket and at the client end, it will be played through simple PCM player after decoding from opus. For running the example, first run the node server by following command:

*node server.js*

then, visit *example/index.html* page through any webserver.

**How to build?**

A distribution version is available inside *dist* directory. However, if you need to build, you can do as follows:

 1. git clone https://github.com/zelloptt/opus-to-pcm.git
 2. cd opus-to-pcm
 3. npm install
 4. npm run build
