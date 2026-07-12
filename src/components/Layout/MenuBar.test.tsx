import { render, screen, fireEvent } from '@testing-library/react';
import MenuBar from './MenuBar';

describe('MenuBar', () => {
  it('renders a button for each of the 5 sections', () => {
    render(<MenuBar />);
    expect(screen.getByRole('button', { name: 'File' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Effects' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Help' })).toBeInTheDocument();
  });

  it('opens the File dropdown on click and lists Open…', () => {
    render(<MenuBar />);
    expect(screen.queryByText('Open…')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'File' }));

    expect(screen.getByText('Open…')).toBeInTheDocument();
  });

  it('marks a disabled stub item as disabled', () => {
    render(<MenuBar />);
    fireEvent.click(screen.getByRole('button', { name: 'File' }));

    const openItem = screen.getByRole('button', { name: /Open…/ });
    expect(openItem).toBeDisabled();
  });

  it('closes the dropdown on Escape', () => {
    render(<MenuBar />);
    fireEvent.click(screen.getByRole('button', { name: 'File' }));
    expect(screen.getByText('Open…')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByText('Open…')).not.toBeInTheDocument();
  });

  it('closes the dropdown on outside click', () => {
    render(
      <div>
        <div data-testid="outside">outside</div>
        <MenuBar />
      </div>
    );
    fireEvent.click(screen.getByRole('button', { name: 'File' }));
    expect(screen.getByText('Open…')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByTestId('outside'));

    expect(screen.queryByText('Open…')).not.toBeInTheDocument();
  });
});
