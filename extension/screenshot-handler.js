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
          top: 0 !important;
          left: 0 !important;
          right: 0 !important;
          bottom: 0 !important;
          width: 100% !important;
          height: 100% !important;
          margin: 0 !important;
          padding: 0 !important;
          border: none !important;
          outline: none !important;
          background: transparent !important;
          box-shadow: none !important;
          z-index: 2147483646 !important;
          cursor: crosshair !important;
          user-select: none !important;
          -webkit-user-select: none !important;
          overflow: hidden !important;
        `;

        // Selection rectangle box: subtle, minimal border with zero blue fill (preserves normal brightness)
        const box = document.createElement('div');
        box.style.cssText = `
          position: absolute !important;
          border: 1.5px solid rgba(17, 24, 39, 0.85) !important;
          outline: 1px dashed rgba(255, 255, 255, 0.9) !important;
          background-color: transparent !important;
          background: transparent !important;
          box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.08) !important;
          box-sizing: border-box !important;
          display: none !important;
          pointer-events: none !important;
          margin: 0 !important;
          padding: 0 !important;
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
          // Keep display none on mousedown to prevent 0x0 dot / line artifact before user starts dragging
          box.style.display = 'none';
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

          // Only display the box once drag exceeds 2px to eliminate line artifacts
          if (width >= 2 || height >= 2) {
            box.style.left = `${left}px`;
            box.style.top = `${top}px`;
            box.style.width = `${width}px`;
            box.style.height = `${height}px`;
            box.style.display = 'block';
          }
        };

        const onMouseUp = (e) => {
          if (!isDragging) return;
          e.preventDefault();
          e.stopPropagation();
          isDragging = false;
          box.style.display = 'none';

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

            // Downscale to max 1600px dimension for optimal OCR legibility and vision model resolution
            const maxDim = 1600;
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
            // High-quality image smoothing for crisp text and equations
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, sx, sy, sw, sh, 0, 0, destW, destH);

            // Compress to JPEG with 0.92 high-fidelity quality for sharp OCR
            const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.92);
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
