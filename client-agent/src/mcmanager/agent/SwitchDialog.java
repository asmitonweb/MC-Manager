package mcmanager.agent;

import javax.swing.JDialog;
import javax.swing.JOptionPane;
import javax.swing.UIManager;

/**
 * The "server switched worlds" prompt, run as its own process by the agent.
 * Exit code 10 means "close the game so I can start the right entry".
 *
 *   SwitchDialog <server name> <entry the player started> <entry to pick>
 */
public final class SwitchDialog {
    private SwitchDialog() {}

    public static void main(String[] args) {
        String server = args[0], started = args[1], pick = args[2];
        try {
            UIManager.setLookAndFeel(UIManager.getSystemLookAndFeelClassName());
        } catch (Exception ignored) {
            // The default look works too.
        }
        String message = server + " has switched worlds.\n\n"
            + "You started:  " + started + "\n"
            + "That entry can't join the server any more.\n\n"
            + "In your launcher, pick:\n    " + pick + "\n\n"
            + "Close the game now? The right entry will be selected in your launcher.";
        Object[] options = { "Close the game", "Play anyway" };
        JOptionPane pane = new JOptionPane(message, JOptionPane.WARNING_MESSAGE, JOptionPane.YES_NO_OPTION, null, options, options[1]);
        // On top of the launcher, which still has focus while the game starts.
        // "Play anyway" is the default, so a stray Enter never closes the game.
        JDialog dialog = pane.createDialog(server + " - world changed");
        dialog.setAlwaysOnTop(true);
        dialog.setVisible(true);
        dialog.toFront();
        dialog.dispose();
        System.exit(options[0].equals(pane.getValue()) ? 10 : 0);
    }
}
