import { objectTypeForOriginAndContentType } from "../object-types";
import { getReticulumFetchUrl } from "./phoenix-utils";
import mediaHighlightFrag from "./media-highlight-frag.glsl";
import { mapMaterials } from "./material-utils";

const nonCorsProxyDomains = (process.env.NON_CORS_PROXY_DOMAINS || "").split(",");
if (process.env.CORS_PROXY_SERVER) {
  nonCorsProxyDomains.push(process.env.CORS_PROXY_SERVER);
}
const mediaAPIEndpoint = getReticulumFetchUrl("/api/v1/media");

const commonKnownContentTypes = {
  gltf: "model/gltf",
  glb: "model/gltf-binary",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  pdf: "application/pdf",
  mp4: "video/mp4",
  mp3: "audio/mpeg"
};

const PHYSICS_CONSTANTS = require("aframe-physics-system/src/constants"),
  SHAPE = PHYSICS_CONSTANTS.SHAPE,
  FIT = PHYSICS_CONSTANTS.FIT;

// thanks to https://developer.mozilla.org/en-US/docs/Web/API/WindowBase64/Base64_encoding_and_decoding
function b64EncodeUnicode(str) {
  // first we use encodeURIComponent to get percent-encoded UTF-8, then we convert the percent-encodings
  // into raw bytes which can be fed into btoa.
  const CHAR_RE = /%([0-9A-F]{2})/g;
  return btoa(encodeURIComponent(str).replace(CHAR_RE, (_, p1) => String.fromCharCode("0x" + p1)));
}

const farsparkEncodeUrl = url => {
  // farspark doesn't know how to read '=' base64 padding characters
  // translate base64 + to - and / to _ for URL safety
  return b64EncodeUnicode(url)
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
};

export const scaledThumbnailUrlFor = (url, width, height) => {
  if (
    process.env.RETICULUM_SERVER &&
    process.env.RETICULUM_SERVER.includes("hubs.local") &&
    url.includes("hubs.local")
  ) {
    return url;
  }

  return `https://${process.env.FARSPARK_SERVER}/thumbnail/${farsparkEncodeUrl(url)}?w=${width}&h=${height}`;
};

export const proxiedUrlFor = (url, index = null) => {
  if (!(url.startsWith("http:") || url.startsWith("https:"))) return url;

  const hasIndex = index !== null;

  if (!hasIndex) {
    // Skip known domains that do not require CORS proxying.
    try {
      const parsedUrl = new URL(url);
      if (nonCorsProxyDomains.find(domain => parsedUrl.hostname.endsWith(domain))) return url;
    } catch (e) {
      // Ignore
    }
  }

  if (hasIndex || !process.env.CORS_PROXY_SERVER) {
    const method = hasIndex ? "extract" : "raw";
    return `https://${process.env.FARSPARK_SERVER}/0/${method}/0/0/0/${index || 0}/${farsparkEncodeUrl(url)}`;
  } else {
    return `https://${process.env.CORS_PROXY_SERVER}/${url}`;
  }
};

const resolveUrlCache = new Map();
export const resolveUrl = async (url, index) => {
  const cacheKey = `${url}|${index}`;
  if (resolveUrlCache.has(cacheKey)) return resolveUrlCache.get(cacheKey);
  const resolved = await fetch(mediaAPIEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ media: { url, index } })
  }).then(r => r.json());
  resolveUrlCache.set(cacheKey, resolved);
  return resolved;
};

export const getCustomGLTFParserURLResolver = gltfUrl => url => {
  if (typeof url !== "string" || url === "") return "";
  if (/^(https?:)?\/\//i.test(url)) return url;
  if (/^data:.*,.*$/i.test(url)) return url;
  if (/^blob:.*$/i.test(url)) return url;

  if (process.env.CORS_PROXY_SERVER) {
    // For absolute paths with a CORS proxied gltf URL, re-write the url properly to be proxied
    const corsProxyPrefix = `https://${process.env.CORS_PROXY_SERVER}/`;

    if (gltfUrl.startsWith(corsProxyPrefix)) {
      const originalUrl = decodeURIComponent(gltfUrl.substring(corsProxyPrefix.length));
      const originalUrlParts = originalUrl.split("/");

      // Drop the .gltf filename
      const path = new URL(url).pathname;
      const assetUrl = originalUrlParts.slice(0, originalUrlParts.length - 1).join("/") + "/" + path;
      return corsProxyPrefix + assetUrl;
    }
  }

  return url;
};

export const guessContentType = url => {
  if (url.startsWith("hubs://") && url.endsWith("/video")) return "video/vnd.hubs-webrtc";
  const extension = new URL(url).pathname.split(".").pop();
  return commonKnownContentTypes[extension];
};

export const upload = file => {
  const formData = new FormData();
  formData.append("media", file);
  formData.append("promotion_mode", "with_token");
  return fetch(mediaAPIEndpoint, {
    method: "POST",
    body: formData
  }).then(r => r.json());
};

// https://stackoverflow.com/questions/7584794/accessing-jpeg-exif-rotation-data-in-javascript-on-the-client-side/32490603#32490603
function getOrientation(file, callback) {
  const reader = new FileReader();
  reader.onload = function(e) {
    const view = new DataView(e.target.result);
    if (view.getUint16(0, false) != 0xffd8) {
      return callback(-2);
    }
    const length = view.byteLength;
    let offset = 2;
    while (offset < length) {
      if (view.getUint16(offset + 2, false) <= 8) return callback(-1);
      const marker = view.getUint16(offset, false);
      offset += 2;
      if (marker == 0xffe1) {
        if (view.getUint32((offset += 2), false) != 0x45786966) {
          return callback(-1);
        }

        const little = view.getUint16((offset += 6), false) == 0x4949;
        offset += view.getUint32(offset + 4, little);
        const tags = view.getUint16(offset, little);
        offset += 2;
        for (let i = 0; i < tags; i++) {
          if (view.getUint16(offset + i * 12, little) == 0x0112) {
            return callback(view.getUint16(offset + i * 12 + 8, little));
          }
        }
      } else if ((marker & 0xff00) != 0xff00) {
        break;
      } else {
        offset += view.getUint16(offset, false);
      }
    }
    return callback(-1);
  };
  reader.readAsArrayBuffer(file);
}

let interactableId = 0;
export const addMedia = (src, template, contentOrigin, resolve = false, resize = false, animate = true) => {
  const scene = AFRAME.scenes[0];

  const entity = document.createElement("a-entity");
  entity.id = "interactable-media-" + interactableId++;
  entity.setAttribute("networked", { template: template });
  const needsToBeUploaded = src instanceof File;
  entity.setAttribute("media-loader", {
    resize,
    resolve,
    animate,
    src: typeof src === "string" ? src : "",
    fileIsOwned: !needsToBeUploaded
  });

  entity.object3D.matrixNeedsUpdate = true;

  scene.appendChild(entity);

  const fireLoadingTimeout = setTimeout(() => {
    scene.emit("media-loading", { src: src });
  }, 100);

  ["model-loaded", "video-loaded", "image-loaded"].forEach(eventName => {
    entity.addEventListener(
      eventName,
      async () => {
        clearTimeout(fireLoadingTimeout);
        scene.emit("media-loaded", { src: src });
      },
      { once: true }
    );
  });

  const orientation = new Promise(function(resolve) {
    if (needsToBeUploaded) {
      getOrientation(src, x => {
        resolve(x);
      });
    } else {
      resolve(1);
    }
  });
  if (needsToBeUploaded) {
    upload(src)
      .then(response => {
        const srcUrl = new URL(response.raw);
        srcUrl.searchParams.set("token", response.meta.access_token);
        entity.setAttribute("media-loader", { resolve: false, src: srcUrl.href, fileId: response.file_id });
        window.APP.store.update({
          uploadPromotionTokens: [{ fileId: response.file_id, promotionToken: response.meta.promotion_token }]
        });
      })
      .catch(e => {
        console.error("Media upload failed", e);
        entity.setAttribute("media-loader", { src: "error" });
      });
  } else if (src instanceof MediaStream) {
    entity.setAttribute("media-loader", { src: `hubs://clients/${NAF.clientId}/video` });
  }

  if (contentOrigin) {
    entity.addEventListener("media_resolved", ({ detail }) => {
      const objectType = objectTypeForOriginAndContentType(contentOrigin, detail.contentType, detail.src);
      scene.emit("object_spawned", { objectType });
    });
  }

  return { entity, orientation };
};

export function injectCustomShaderChunks(obj) {
  const vertexRegex = /\bskinning_vertex\b/;
  const fragRegex = /\bgl_FragColor\b/;
  const validMaterials = ["MeshStandardMaterial", "MeshBasicMaterial", "MobileStandardMaterial"];

  const shaderUniforms = [];

  obj.traverse(object => {
    if (!object.material) return;

    object.material = mapMaterials(object, material => {
      if (!validMaterials.includes(material.type)) {
        return material;
      }

      // HACK, this routine inadvertently leaves the A-Frame shaders wired to the old, dark
      // material, so maps cannot be updated at runtime. This breaks UI elements who have
      // hover/toggle state, so for now just skip these while we figure out a more correct
      // solution.
      if (object.el.classList.contains("ui")) return material;
      if (object.el.classList.contains("hud")) return material;
      if (object.el.getAttribute("text-button")) return material;

      const newMaterial = material.clone();
      newMaterial.onBeforeCompile = shader => {
        if (!vertexRegex.test(shader.vertexShader)) return;

        shader.uniforms.hubs_IsFrozen = { value: false };
        shader.uniforms.hubs_EnableSweepingEffect = { value: false };
        shader.uniforms.hubs_SweepParams = { value: [0, 0] };
        shader.uniforms.hubs_InteractorOnePos = { value: [0, 0, 0] };
        shader.uniforms.hubs_InteractorTwoPos = { value: [0, 0, 0] };
        shader.uniforms.hubs_HighlightInteractorOne = { value: false };
        shader.uniforms.hubs_HighlightInteractorTwo = { value: false };
        shader.uniforms.hubs_Time = { value: 0 };

        const vchunk = `
        if (hubs_HighlightInteractorOne || hubs_HighlightInteractorTwo || hubs_IsFrozen) {
          vec4 wt = modelMatrix * vec4(transformed, 1);

          // Used in the fragment shader below.
          hubs_WorldPosition = wt.xyz;
        }
      `;

        const vlines = shader.vertexShader.split("\n");
        const vindex = vlines.findIndex(line => vertexRegex.test(line));
        vlines.splice(vindex + 1, 0, vchunk);
        vlines.unshift("varying vec3 hubs_WorldPosition;");
        vlines.unshift("uniform bool hubs_IsFrozen;");
        vlines.unshift("uniform bool hubs_HighlightInteractorOne;");
        vlines.unshift("uniform bool hubs_HighlightInteractorTwo;");
        shader.vertexShader = vlines.join("\n");

        const flines = shader.fragmentShader.split("\n");
        const findex = flines.findIndex(line => fragRegex.test(line));
        flines.splice(findex + 1, 0, mediaHighlightFrag);
        flines.unshift("varying vec3 hubs_WorldPosition;");
        flines.unshift("uniform bool hubs_IsFrozen;");
        flines.unshift("uniform bool hubs_EnableSweepingEffect;");
        flines.unshift("uniform vec2 hubs_SweepParams;");
        flines.unshift("uniform bool hubs_HighlightInteractorOne;");
        flines.unshift("uniform vec3 hubs_InteractorOnePos;");
        flines.unshift("uniform bool hubs_HighlightInteractorTwo;");
        flines.unshift("uniform vec3 hubs_InteractorTwoPos;");
        flines.unshift("uniform float hubs_Time;");
        shader.fragmentShader = flines.join("\n");

        shaderUniforms.push(shader.uniforms);
      };
      newMaterial.needsUpdate = true;
      return newMaterial;
    });
  });

  return shaderUniforms;
}

export function getPromotionTokenForFile(fileId) {
  return window.APP.store.state.uploadPromotionTokens.find(upload => upload.fileId === fileId);
}

function exceedsDensityThreshold(count, subtree) {
  const bounds = subtree.boundingData;
  const triangleThreshold = 1000;
  const minimumVolume = 0.1;
  const minimumTriangles = 100;
  const dx = bounds[3] - bounds[0];
  const dy = bounds[4] - bounds[1];
  const dz = bounds[5] - bounds[2];
  const volume = dx * dy * dz;

  if (volume < minimumVolume) {
    return false;
  }

  if (count < minimumTriangles) {
    return false;
  }

  return count / volume > triangleThreshold;
}

function isHighDensity(subtree) {
  if (subtree.count) {
    const result = exceedsDensityThreshold(subtree.count, subtree);
    return result === true ? true : subtree.count;
  } else {
    const leftResult = isHighDensity(subtree.left);
    if (leftResult === true) return true;
    const rightResult = isHighDensity(subtree.right);
    if (rightResult === true) return true;

    const count = leftResult + rightResult;
    const result = exceedsDensityThreshold(count, subtree);
    return result === true ? true : count;
  }
}

function isGeometryHighDensity(geo) {
  const bvh = geo.boundsTree;
  const roots = bvh._roots;
  for (let i = 0; i < roots.length; ++i) {
    return isHighDensity(roots[i]) === true;
  }
  return false;
}

export const traverseMeshesAndAddShapes = (function() {
  const shapePrefix = "ammo-shape__";
  const shapes = [];
  return function(el) {
    const meshRoot = el.object3DMap.mesh;
    while (shapes.length > 0) {
      const { id, entity } = shapes.pop();
      entity.removeAttribute(id);
    }

    console.group("traverseMeshesAndAddShapes");

    if (document.querySelector(["[ammo-shape__trimesh]", "[ammo-shape__heightfield]"])) {
      console.log("heightfield or trimesh found on scene");
    } else {
      console.log("collision not found in scene");

      let isHighDensity = false;
      meshRoot.traverse(o => {
        if (
          o.isMesh &&
          (!THREE.Sky || o.__proto__ != THREE.Sky.prototype) &&
          !o.name.startsWith("Floor_Plan") &&
          !o.name.startsWith("Ground_Plane") &&
          o.geometry.boundsTree
        ) {
          if (isGeometryHighDensity(o.geometry)) {
            isHighDensity = true;
            return;
          }
        }
      });

      let navMesh = null;

      if (isHighDensity) {
        console.log("mesh contains high triangle density region");
        navMesh = document.querySelector("[nav-mesh]");
      }

      if (navMesh) {
        console.log(`mesh density exceeded, using floor plan only`);
        navMesh.setAttribute(shapePrefix + "floorPlan", {
          type: SHAPE.MESH,
          margin: 0.01,
          fit: FIT.ALL,
          includeInvisible: true
        });
        shapes.push({ id: shapePrefix + "floorPlan", entity: navMesh });
      } else if (!isHighDensity) {
        el.setAttribute(shapePrefix + "environment", {
          type: SHAPE.MESH,
          margin: 0.01,
          fit: FIT.ALL
        });
        shapes.push({ id: shapePrefix + "environment", entity: el });
        console.log("adding mesh shape for all visible meshes");
      } else {
        el.setAttribute(shapePrefix + "defaultFloor", {
          type: SHAPE.BOX,
          margin: 0.01,
          halfExtents: { x: 4000, y: 0.5, z: 4000 },
          offset: { x: 0, y: -0.5, z: 0 },
          fit: FIT.MANUAL
        });
        shapes.push({ id: shapePrefix + "defaultFloor", entity: el });
        console.log("adding default floor collision");
      }
    }
    console.groupEnd();
  };
})();

const mediaPos = new THREE.Vector3();

export function spawnMediaAround(el, media, snapCount, mirrorOrientation = false) {
  const { entity, orientation } = addMedia(media, "#interactable-media", undefined, false);

  const pos = el.object3D.position;

  entity.object3D.position.set(pos.x, pos.y, pos.z);
  entity.object3D.rotation.copy(el.object3D.rotation);

  if (mirrorOrientation) {
    entity.object3D.rotateY(Math.PI);
  }

  // Generate photos in a circle around camera, starting from the bottom.
  // Prevent z-fighting but place behind viewfinder
  const idx = (snapCount % 6) + 3;

  mediaPos.set(
    Math.cos(Math.PI * 2 * (idx / 6.0)) * 0.75,
    Math.sin(Math.PI * 2 * (idx / 6.0)) * 0.75,
    -0.05 + idx * 0.001
  );

  el.object3D.localToWorld(mediaPos);
  entity.object3D.visible = false;

  entity.addEventListener(
    "image-loaded",
    () => {
      entity.object3D.visible = true;
      entity.setAttribute("animation__photo_pos", {
        property: "position",
        dur: 800,
        from: { x: pos.x, y: pos.y, z: pos.z },
        to: { x: mediaPos.x, y: mediaPos.y, z: mediaPos.z },
        easing: "easeOutElastic"
      });
    },
    { once: true }
  );

  entity.object3D.matrixNeedsUpdate = true;

  entity.addEventListener(
    "media_resolved",
    () => {
      el.emit("photo_taken", entity.components["media-loader"].data.src);
    },
    { once: true }
  );

  return { entity, orientation };
}

const hubsSceneRegex = /https?:\/\/(hubs.local(:\d+)?|(smoke-)?hubs.mozilla.com)\/scenes\/(\w+)\/?\S*/;
const hubsRoomRegex = /https?:\/\/(hubs.local(:\d+)?|(smoke-)?hubs.mozilla.com)\/(\w+)\/?\S*/;
export const isHubsSceneUrl = hubsSceneRegex.test.bind(hubsSceneRegex);
export const isHubsRoomUrl = url => !isHubsSceneUrl(url) && hubsRoomRegex.test(url);
export const isHubsDestinationUrl = url => isHubsSceneUrl(url) || isHubsRoomUrl(url);
