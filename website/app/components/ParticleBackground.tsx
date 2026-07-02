"use client";

import { useEffect, useRef } from "react";

const DOT_COLORS    = ["#534AB7","#7F77DD","#AFA9EC","#D4537E","#5DCAA5","#FAC775"];
const BUBBLE_COLORS = ["#534AB7","#3C3489","#D4537E","#0F6E56"];
const TOTAL         = 75;
const BUBBLE_COUNT  = 14;
const BW = 42, BH = 26, BR = 5;
const CONNECT_DIST  = 115;
const MOUSE_DIST    = 140;

interface Particle {
  x: number; y: number;
  vx: number; vy: number; baseVy: number;
  r: number; color: string;
  isBubble: boolean;
  tail: "left" | "right";
  opacity: number;
}

export default function ParticleBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current as HTMLCanvasElement;
    if (!canvas) return;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;

    let W = 0, H = 0;
    let particles: Particle[] = [];
    let scrollY = 0;
    let mouse = { x: -999, y: -999 };
    let raf: number;

    function drawBubble(cx: number, cy: number, color: string, alpha: number, tail: "left" | "right") {
      const x = cx - BW / 2, y = cy - BH / 2;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x + BR, y);
      ctx.lineTo(x + BW - BR, y);
      ctx.quadraticCurveTo(x + BW, y, x + BW, y + BR);
      ctx.lineTo(x + BW, y + BH - BR);
      ctx.quadraticCurveTo(x + BW, y + BH, x + BW - BR, y + BH);
      if (tail === "right") {
        ctx.lineTo(x + BW * 0.72 + 4, y + BH);
        ctx.lineTo(x + BW * 0.72 + 4, y + BH + 6);
        ctx.lineTo(x + BW * 0.72 - 4, y + BH);
      }
      ctx.lineTo(x + BR, y + BH);
      ctx.quadraticCurveTo(x, y + BH, x, y + BH - BR);
      if (tail === "left") {
        ctx.lineTo(x, y + BH * 0.7 + 4);
        ctx.lineTo(x - 6, y + BH * 0.7 + 4);
        ctx.lineTo(x, y + BH * 0.7 - 4);
      }
      ctx.lineTo(x, y + BR);
      ctx.quadraticCurveTo(x, y, x + BR, y);
      ctx.closePath();
      ctx.fill();

      ctx.globalAlpha = alpha * 0.65;
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      [-5, 0, 5].forEach(dx => {
        ctx.beginPath();
        ctx.arc(cx + dx, cy, 1.5, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;
    }

    function init() {
      particles = [];
      for (let i = 0; i < TOTAL; i++) {
        const isBubble = i < BUBBLE_COUNT;
        particles.push({
          x: Math.random() * W,
          y: Math.random() * H,
          vx: (Math.random() - 0.5) * 0.45,
          vy: (Math.random() - 0.5) * 0.45,
          baseVy: (Math.random() - 0.5) * 0.45,
          r: Math.random() * 2 + 1.5,
          color: isBubble
            ? BUBBLE_COLORS[Math.floor(Math.random() * BUBBLE_COLORS.length)]
            : DOT_COLORS[Math.floor(Math.random() * DOT_COLORS.length)],
          isBubble,
          tail: Math.random() > 0.5 ? "left" : "right",
          opacity: isBubble ? Math.random() * 0.2 + 0.18 : 0.8,
        });
      }
    }

    function resize() {
      W = canvas.width = window.innerWidth;
      H = canvas.height = canvas.offsetHeight;
      init();
    }

    function draw() {
      scrollY = window.scrollY;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "#0f0d1f";
      ctx.fillRect(0, 0, W, H);

      const speedBoost = scrollY * 0.002;

      particles.forEach(p => {
        p.vy = p.baseVy;
        p.x += p.vx; p.y += p.vy;
        if (p.x < -60) p.x = W + 60;
        if (p.x > W + 60) p.x = -60;
        if (p.y < -60) p.y = H + 60;
        if (p.y > H + 60) p.y = -60;

        const dm = Math.hypot(p.x - mouse.x, p.y - mouse.y);
        if (dm < MOUSE_DIST && dm > 0) {
          const force = (1 - dm / MOUSE_DIST) * 0.9;
          p.x += (p.x - mouse.x) / dm * force;
          p.y += (p.y - mouse.y) / dm * force;
        }
      });

      const shifted = particles.map(p => ({
        ...p,
        drawY: p.isBubble ? p.y - scrollY * 0.15 : p.y - scrollY * 0.08,
      }));

      for (let i = 0; i < shifted.length; i++) {
        for (let j = i + 1; j < shifted.length; j++) {
          const a = shifted[i], b = shifted[j];
          const dist = Math.hypot(a.x - b.x, a.drawY - b.drawY);
          if (dist < CONNECT_DIST) {
            ctx.globalAlpha = (1 - dist / CONNECT_DIST) * 0.22;
            ctx.strokeStyle = "#AFA9EC";
            ctx.lineWidth = 0.6;
            ctx.beginPath();
            ctx.moveTo(a.x, a.drawY);
            ctx.lineTo(b.x, b.drawY);
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
        }
      }

      shifted.forEach(p => {
        if (p.isBubble) {
          drawBubble(p.x, p.drawY, p.color, p.opacity, p.tail);
        } else {
          ctx.beginPath();
          ctx.arc(p.x, p.drawY, p.r, 0, Math.PI * 2);
          ctx.fillStyle = p.color;
          ctx.globalAlpha = 0.8;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      });

      raf = requestAnimationFrame(draw);
    }

    function onMouseMove(e: MouseEvent) {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
    }
    function onMouseLeave() { mouse.x = -999; mouse.y = -999; }

    resize();
    draw();
    window.addEventListener("resize", resize);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseleave", onMouseLeave);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseleave", onMouseLeave);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full"
      aria-hidden="true"
    />
  );
}
