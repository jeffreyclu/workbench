import React, { useEffect, useRef } from 'react';
import { Graph } from '@antv/x6';

export const X6Demo: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      // Clear previous graph instance if any
      containerRef.current.innerHTML = '';
      const graph = new Graph({
        container: containerRef.current,
        width: 600,
        height: 400,
        grid: true,
      });
      graph.addNode({
        x: 40,
        y: 40,
        width: 100,
        height: 40,
        label: 'Hello X6',
      });
    }
  }, []);

  return <div ref={containerRef} style={{ border: '1px solid #ccc', margin: 16 }} />;
};
