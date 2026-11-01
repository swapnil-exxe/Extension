/**
 * Moodle AI Quick Answer - Screenshot Handler
 * Captures, crops, and compresses question areas in-memory for vision-based question solving.
 */

(function () {
  'use strict';

  if (window.MoodleScreenshotHandler) return;

  const ScreenshotHandler = {
    /**
     * Display an interactive crosshair overlay for user to drag and select screen area
     * Returns Promise<{ x, y, width, height, devicePixelRatio } | null>
     */
    promptUserSelectionArea() {
      return new Promise((resolve) => {
        // Prevent duplicate overlays
        const existing = document.getElementById('moodle-snipping-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'moodle-snipping-overlay';
        overlay.style.cssText = `
          position: fixed !important;
          inset: 0 !important;
          width: 100vw !important;
          height: 100vh !important;
          z-index: 2147483646 !important;
          background: transparent !important;
          cursor: crosshair !important;
          user-select: none !important;
          -webkit-user-select: none !important;
          overflow: hidden !important;
        `;

        // Hint bar removed to keep overlay completely clean, invisible, and stealthy
        // Selection rectangle box (no dark backdrop, normal brightness maintained)
        const box = document.createElement('div');
        box.style.cssText = `
          position: absolute !important;
          border: 2px dashed #000000 !important;
          background: rgba(0, 0, 0, 0.04) !important;
          box-shadow: none !important;
          display: none !important;
          pointer-events: none !important;
        `;
        overlay.appendChild(box);

        let isDragging = false;
        let startX = 0;
        let startY = 0;

        const cleanup = () => {
          window.removeEventListener('keydown', onKeyDown, true);
          window.removeEventListener('mousemove', onMouseMove, true);
          window.removeEventListener('mouseup', onMouseUp, true);
          if (overlay.parentElement) overlay.parentElement.removeChild(overlay);
        };

        const onMouseDown = (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          isDragging = true;
          startX = e.clientX;
          startY = e.clientY;
          box.style.left = `${startX}px`;
          box.style.top = `${startY}px`;
          box.style.width = '0px';
          box.style.height = '0px';
          box.style.display = 'block';
        };

        const onMouseMove = (e) => {
          if (!isDragging) return;
          e.preventDefault();
          e.stopPropagation();

          const currentX = e.clientX;
          const currentY = e.clientY;
          const left = Math.min(startX, currentX);
          const top = Math.min(startY, currentY);
          const width = Math.abs(currentX - startX);
          const height = Math.abs(currentY - startY);

          box.style.left = `${left}px`;
          box.style.top = `${top}px`;
          box.style.width = `${width}px`;
          box.style.height = `${height}px`;
        };

        const onMouseUp = (e) => {
          if (!isDragging) return;
          e.preventDefault();
          e.stopPropagation();
          isDragging = false;

          const currentX = e.clientX;
          const currentY = e.clientY;
          const left = Math.min(startX, currentX);
          const top = Math.min(startY, currentY);
          const width = Math.abs(currentX - startX);
          const height = Math.abs(currentY - startY);

          cleanup();

          if (width >= 15 && height >= 15) {
            resolve({
              x: left,
              y: top,
              width,
              height,
              devicePixelRatio: window.devicePixelRatio || 1
            });
          } else {
            resolve(null);
          }
        };

        const onKeyDown = (e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            cleanup();
            resolve(null);
          }
        };

        overlay.addEventListener('mousedown', onMouseDown, true);
        window.addEventListener('mousemove', onMouseMove, true);
        window.addEventListener('mouseup', onMouseUp, true);
        window.addEventListener('keydown', onKeyDown, true);

        document.body.appendChild(overlay);
      });
    },

    /**
     * Compute bounding box coordinates of the target question element in viewport
     */
    getQuestionCropRect(element) {
      if (!element || typeof element.getBoundingClientRect !== 'function') {
        return null;
      }

      const rect = element.getBoundingClientRect();

      // Ensure dimensions are positive and element is at least partially in viewport
      if (rect.width <= 0 || rect.height <= 0) {
        return null;
      }

      const dpr = window.devicePixelRatio || 1;
      const padding = 10; // 10px buffer around question border

      const x = Math.max(0, rect.left - padding);
      const y = Math.max(0, rect.top - padding);
      const width = Math.min(window.innerWidth - x, rect.width + (padding * 2));
      const height = Math.min(window.innerHeight - y, rect.height + (padding * 2));

      return {
        x,
        y,
        width,
        height,
        devicePixelRatio: dpr
      };
    },

    /**
     * Crop captured viewport image to the specified rectangle and compress to JPEG
     */
    async cropImage(fullDataUrl, cropRect) {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          try {
            const canvas = document.createElement('canvas');
            const dpr = (cropRect && cropRect.devicePixelRatio) || 1;

            let sx = 0;
            let sy = 0;
            let sw = img.width;
            let sh = img.height;

            if (cropRect && cropRect.width && cropRect.height) {
              sx = Math.max(0, Math.round(cropRect.x * dpr));
              sy = Math.max(0, Math.round(cropRect.y * dpr));
              sw = Math.min(img.width - sx, Math.round(cropRect.width * dpr));
              sh = Math.min(img.height - sy, Math.round(cropRect.height * dpr));
            }

            if (sw <= 20 || sh <= 20) {
              sx = 0; sy = 0; sw = img.width; sh = img.height;
            }

            // Downscale to max 1200px dimension for fast network latency & lower payload size
            const maxDim = 1200;
            let destW = sw;
            let destH = sh;
            if (destW > maxDim || destH > maxDim) {
              if (destW > destH) {
                destH = Math.round((destH * maxDim) / destW);
                destW = maxDim;
              } else {
                destW = Math.round((destW * maxDim) / destH);
                destH = maxDim;
              }
            }

            canvas.width = destW;
            canvas.height = destH;

            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, sx, sy, sw, sh, 0, 0, destW, destH);

            // Compress to JPEG with 0.80 quality
            const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.80);
            resolve(compressedDataUrl);
          } catch (err) {
            console.warn('[Moodle AI] Image processing failed, using original:', err.message);
            resolve(fullDataUrl);
          }
        };

        img.onerror = () => {
          resolve(fullDataUrl);
        };

        img.src = fullDataUrl;
      });
    }
  };

  window.MoodleScreenshotHandler = ScreenshotHandler;
})();
